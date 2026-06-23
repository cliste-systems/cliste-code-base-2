import { llm, voice } from '@livekit/agents';
import { z } from 'zod';

import {
  callRoutingAllowsHumanTransfer,
  parseCallRoutingMode,
} from './call_routing.js';
import { maskPhone } from './gdpr.js';
import { isE164SmsTarget } from './phone_classify.js';
import {
  fallbackRoute,
  isBookingRoute,
  isLocationRoute,
  listActiveRouteIds,
  parseRoutingLinks,
  resolveRoute,
  routeTrigger,
  routeUsesCallerLinkDelivery,
  type RoutingLink,
} from './routing_links.js';
import {
  createBusinessFileSignedUrl,
  type BusinessFileRow,
} from './supabase.js';
import { insertActionTicket } from './action_tickets.js';
import { disconnectCallerLeg, type EndCallUserData } from './end_call.js';
import { normalizePhoneE164 } from './phone_normalize.js';
import { sendTwilioSms, twilioSmsConfigured, caraSmsDryRunEnabled } from './twilio_sms.js';
import {
  postSendCallerEmail,
  postSearchBusinessFile,
  postSendSms,
  voiceWebhooksConfigured,
  type SearchBusinessFilePayload,
} from './voice_api.js';

const SMS_FAILURE_MESSAGE =
  'SMS failed — tell the caller you could not text the link and offer to take a message. Do not read the URL.';

export type CaraSessionFlags = {
  linkSent: boolean;
  actionTicketCreated: boolean;
  callbackRequested: boolean;
  smsSent: number;
  endPhoneCallUsed: boolean;
  askedAnythingElse: boolean;
  awaitingAnythingElseReply: boolean;
  anythingElseAskCount: number;
  callerRespondedAfterAnythingElse: boolean;
  bookingLinkConsentPending: boolean;
  bookingLinkConsentGranted: boolean;
  bookingRouteId: string | null;
  bookingLinkSendInFlight: boolean;
  userTurnsSinceBookingOffer: number;
  closingCall: boolean;
  bookingSmsAutoSendStarted: boolean;
  bookingLinkConsentOfferSpoken: boolean;
  likelySttGarble: boolean;
  bookingSendConfirmedSpoken: boolean;
  assistantClaimedLinkSentSpoken: boolean;
};

export type CaraAgentUserData = {
  organizationId: string;
  businessName: string;
  calledNumber: string;
  callerPhone: string;
  routingLinks: RoutingLink[];
  businessFiles: BusinessFileRow[];
  fallbackNumber: string | null;
  callRoutingMode: string | null;
  sessionFlags: CaraSessionFlags;
  disclosureConfirmed: boolean;
  endCallTarget?: { roomName: string; callerIdentity: string };
};

function readCaraUserData(ctx: { userData: unknown }): CaraAgentUserData {
  const ud = ctx.userData as CaraAgentUserData;
  if (!ud?.organizationId) {
    throw new Error('Missing session userData.organizationId');
  }
  return ud;
}

function routeLookupFailure(links: RoutingLink[], routeId: string): string {
  const ids = listActiveRouteIds(links);
  const hint = ids.length > 0 ? ` Valid routeIds: ${ids.join(', ')}.` : '';
  return `Unknown routeId "${routeId}".${hint} Match a route from Active routes in your instructions.`;
}

function resolveRouteOrFail(
  links: RoutingLink[],
  routeId: string,
): { ok: true; route: RoutingLink } | { ok: false; message: string } {
  const route = resolveRoute(links, routeId);
  if (!route) {
    return { ok: false, message: routeLookupFailure(links, routeId) };
  }
  return { ok: true, route };
}

async function maybeAcknowledgeToolStart(
  _session: voice.AgentSession<CaraAgentUserData>,
): Promise<void> {
  /* no-op — programmatic "just a moment" overlapped LLM speech and goodbye */
}

export async function sendCallerSms(
  ud: CaraAgentUserData,
  to: string,
  body: string,
  toolName: string,
): Promise<{ ok: boolean; detail: string }> {
  const startedAt = Date.now();
  if (!ud.calledNumber.trim()) {
    const detail = 'Missing dialed number for SMS routing.';
    console.error('[sms]', { tool: toolName, to: maskPhone(to), ok: false, error: detail });
    return { ok: false, detail };
  }

  if (caraSmsDryRunEnabled()) {
    const bodyPreview = body.length > 160 ? `${body.slice(0, 160)}…` : body;
    console.info('[sms] dry_run', {
      tool: toolName,
      channel: 'dry_run',
      calledNumber: maskPhone(ud.calledNumber),
      to: maskPhone(to),
      body: bodyPreview,
      ok: true,
      durationMs: Date.now() - startedAt,
    });
    return { ok: true, detail: 'Sent (dry run — no SMS delivered).' };
  }

  if (twilioSmsConfigured()) {
    const twilioResult = await sendTwilioSms(to, body, {
      organizationId: ud.organizationId,
      fromE164: ud.calledNumber.trim(),
      purpose: toolName,
    });
    const logPayload = {
      tool: toolName,
      channel: 'twilio_direct',
      calledNumber: maskPhone(ud.calledNumber),
      to: maskPhone(to),
      ok: twilioResult.ok,
      error: twilioResult.ok ? undefined : twilioResult.message,
      from: twilioResult.ok ? maskPhone(twilioResult.from) : undefined,
      durationMs: Date.now() - startedAt,
    };
    if (!twilioResult.ok) {
      console.error('[sms]', logPayload);
      return { ok: false, detail: twilioResult.message };
    }
    console.info('[sms]', logPayload);
    return { ok: true, detail: 'Sent.' };
  }

  if (!voiceWebhooksConfigured()) {
    const detail = 'SMS is not configured on this worker.';
    console.error('[sms]', { tool: toolName, to: maskPhone(to), ok: false, error: detail });
    return { ok: false, detail };
  }

  const result = await postSendSms({
    called_number: ud.calledNumber,
    to,
    body,
    caller_consented: true,
    skip_business_prefix: true,
  });
  const logPayload = {
    tool: toolName,
    channel: 'webhook',
    calledNumber: maskPhone(ud.calledNumber),
    to: maskPhone(to),
    ok: result.ok,
    error: result.error,
    durationMs: Date.now() - startedAt,
  };
  if (!result.ok) {
    console.error('[sms]', logPayload);
    return { ok: false, detail: result.error ?? 'SMS send failed.' };
  }
  console.info('[sms]', logPayload);
  return { ok: true, detail: 'Sent.' };
}

/** Send booking/directions link SMS for a route — used by tools and auto-send on consent. */
export async function sendBookingLinkSmsForRoute(
  ud: CaraAgentUserData,
  routeId: string,
  mobilePhone?: string,
): Promise<{ ok: boolean; detail: string }> {
  if (ud.sessionFlags.linkSent) {
    return { ok: true, detail: 'Already sent.' };
  }
  const resolved = resolveRouteOrFail(ud.routingLinks, routeId);
  if (resolved.ok && isBookingRoute(resolved.route) && !ud.sessionFlags.bookingLinkConsentGranted) {
    return {
      ok: false,
      detail: 'Caller has not granted SMS consent — wait for explicit yes on the call.',
    };
  }
  if (ud.sessionFlags.bookingLinkSendInFlight) {
    return { ok: false, detail: 'SMS send already in progress.' };
  }
  ud.sessionFlags.bookingLinkSendInFlight = true;
  try {
    const resolved = resolveRouteOrFail(ud.routingLinks, routeId);
    if (!resolved.ok) {
      return { ok: false, detail: resolved.message };
    }
    const { route } = resolved;
    if (!routeUsesCallerLinkDelivery(route) || !route.url.trim()) {
      return { ok: false, detail: 'Route not found or link delivery is not configured.' };
    }
    const to = resolveSmsDestination(ud, mobilePhone);
    if (!isE164SmsTarget(to)) {
      return {
        ok: false,
        detail: 'This line cannot receive texts. Ask for a mobile number, or offer email instead.',
      };
    }
    const linkUrl = route.url.trim();
    const smsPrefix = isLocationRoute(route)
      ? `${ud.businessName} — directions: `
      : `${ud.businessName}: `;
    const body = `${smsPrefix}${linkUrl}`;
    const sms = await sendCallerSms(ud, to, body, 'sendDirectionsLink');
    if (!sms.ok) {
      return { ok: false, detail: sms.detail };
    }
    ud.sessionFlags.linkSent = true;
    ud.sessionFlags.smsSent += 1;
    ud.sessionFlags.bookingLinkConsentPending = false;
    console.info('sendBookingLinkSmsForRoute', {
      orgId: ud.organizationId,
      routeId,
      to: maskPhone(to),
      ok: true,
    });
    return { ok: true, detail: 'Sent.' };
  } finally {
    ud.sessionFlags.bookingLinkSendInFlight = false;
  }
}

/** Prefer caller-line E.164 when SMS-capable; ignore LLM national-format overrides. */
function resolveSmsDestination(ud: CaraAgentUserData, mobilePhone?: string): string {
  const caller = normalizePhoneE164(ud.callerPhone);
  if (isE164SmsTarget(caller)) return caller;
  if (mobilePhone?.trim()) return normalizePhoneE164(mobilePhone);
  return caller;
}

async function createCallbackViaWebhook(
  ud: CaraAgentUserData,
  summary: string,
  options?: { phone?: string; callerName?: string },
): Promise<{ ok: boolean; message: string }> {
  const caller = options?.phone?.trim()
    ? normalizePhoneE164(options.phone)
    : ud.callerPhone.trim() || 'unknown';
  const name = options?.callerName?.trim() ?? '';
  const summaryWithName = name
    ? `Caller: ${name}. ${summary.trim()}`
    : summary.trim();

  await insertActionTicket({
    organizationId: ud.organizationId,
    calledNumber: ud.calledNumber,
    callerNumber: caller,
    summary: summaryWithName,
    engineeringPriority: 'urgent',
    ...(name ? { callerName: name } : {}),
  });

  ud.sessionFlags.actionTicketCreated = true;
  return {
    ok: true,
    message:
      'Message logged for the team. Tell the caller someone will follow up — do not promise an exact time unless your instructions say so.',
  };
}

export class CaraTools {
  readonly sendRoutingLink = llm.tool({
    description:
      'After matching a send-link route, confirm the caller mobile and SMS the saved URL for that route. Use the routeId from the matched route.',
    parameters: z.object({
      routeId: z.string().min(1).describe('The routing_links id for the matched route'),
      mobilePhone: z
        .string()
        .optional()
        .describe('Omit — caller line is used automatically when SMS-capable.'),
    }),
    execute: async ({ routeId, mobilePhone }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      const resolved = resolveRouteOrFail(ud.routingLinks, routeId);
      if (!resolved.ok) {
        return resolved;
      }
      const { route } = resolved;
      if (isBookingRoute(route)) {
        return {
          ok: false,
          message:
            'Never use this tool for booking — offer the SMS consent phrase and wait; the system auto-sends when the caller says yes.',
        };
      }
      if (routeUsesCallerLinkDelivery(route)) {
        return {
          ok: false,
          message: `Use sendDirectionsLink for this route (routeId ${route.id}). Ask how they want the link, then send with callerConsented true.`,
        };
      }
      if (route.targetType !== 'link' || !route.url.trim()) {
        return {
          ok: false,
          message: 'Route not found or has no link. Take a message with takeCallbackMessage instead.',
        };
      }
      const to = resolveSmsDestination(ud, mobilePhone);
      if (!isE164SmsTarget(to)) {
        return {
          ok: false,
          message:
            'Ask for an SMS-capable mobile number, then retry. Landlines cannot receive texts.',
        };
      }
      const body = `${ud.businessName}: ${route.url.trim()}`;
      const sms = await sendCallerSms(ud, to, body, 'sendRoutingLink');
      if (!sms.ok) {
        return {
          ok: false,
          message: SMS_FAILURE_MESSAGE,
        };
      }
      ud.sessionFlags.linkSent = true;
      ud.sessionFlags.smsSent += 1;
      console.info('sendRoutingLink', {
        orgId: ud.organizationId,
        routeId,
        to: maskPhone(to),
        ok: true,
      });
      return {
        ok: true,
        message: `Link sent for "${routeTrigger(route)}". Confirm it was received.`,
      };
    },
  });

  readonly sendDirectionsLink = llm.tool({
    description:
      'DIRECTIONS / maps links only — never for booking appointments. Booking SMS is automatic after verbal consent. Say the address first for directions, ask consent, then send.',
    parameters: z.object({
      routeId: z.string().min(1).describe('The routing_links id for the route'),
      channel: z
        .enum(['sms', 'email'])
        .describe('How to send the maps link — match the route and what the caller chose'),
      mobilePhone: z
        .string()
        .optional()
        .describe('Omit — caller line is used automatically when SMS-capable.'),
      emailAddress: z
        .string()
        .optional()
        .describe('Caller email — required for email channel; ask on landlines.'),
      callerConsented: z
        .boolean()
        .describe('True after the caller agreed to receive the link this way on the call'),
    }),
    execute: async (
      { routeId, channel, mobilePhone, emailAddress, callerConsented: _callerConsented },
      { ctx },
    ) => {
      const ud = readCaraUserData(ctx);
      const resolved = resolveRouteOrFail(ud.routingLinks, routeId);
      if (!resolved.ok) {
        return resolved;
      }
      const { route } = resolved;
      if (isBookingRoute(route)) {
        return {
          ok: false,
          message:
            'Never use this tool for booking — offer the SMS consent phrase and wait; the system auto-sends when the caller says yes.',
        };
      }
      if (!_callerConsented) {
        return {
          ok: false,
          message: 'Wait for the caller to agree before sending — do not set callerConsented true yourself.',
        };
      }
      if (!routeUsesCallerLinkDelivery(route) || !route.url.trim()) {
        return {
          ok: false,
          message:
            'Route not found or link delivery is not configured. Use sendRoutingLink for simple link routes, or take a message.',
        };
      }

      const delivery = route.linkDelivery ?? 'sms';
      if (delivery !== 'both' && delivery !== channel) {
        return {
          ok: false,
          message: `This route is set to ${delivery} only — use channel "${delivery}".`,
        };
      }

      const linkUrl = route.url.trim();
      const messages: string[] = [];
      const smsPrefix = isLocationRoute(route)
        ? `${ud.businessName} — directions: `
        : `${ud.businessName}: `;

      if (channel === 'sms') {
        const to = resolveSmsDestination(ud, mobilePhone);
        if (!isE164SmsTarget(to)) {
          return {
            ok: false,
            message:
              'This line cannot receive texts. Ask for a mobile number, or offer email instead.',
          };
        }
        const sms = await sendBookingLinkSmsForRoute(ud, routeId, mobilePhone);
        if (!sms.ok) {
          return {
            ok: false,
            message: SMS_FAILURE_MESSAGE,
          };
        }
        messages.push(isLocationRoute(route) ? 'Maps link sent by text.' : 'Booking link sent by text.');
        console.info('sendDirectionsLink', {
          orgId: ud.organizationId,
          routeId,
          channel,
          to: maskPhone(to),
          ok: true,
        });
      }

      if (channel === 'email') {
        const toEmail = emailAddress?.trim().toLowerCase() ?? '';
        if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
          return {
            ok: false,
            message: 'Ask for their email address, spell it back, then retry.',
          };
        }
        if (!voiceWebhooksConfigured()) {
          return {
            ok: false,
            message: SMS_FAILURE_MESSAGE,
          };
        }
        const subject = isLocationRoute(route) ? 'Directions' : 'Booking link';
        const body = isLocationRoute(route)
          ? `Here are directions to ${ud.businessName}:\n\n${linkUrl}`
          : `Here is your booking link for ${ud.businessName}:\n\n${linkUrl}`;
        const mail = await postSendCallerEmail({
          called_number: ud.calledNumber,
          to: toEmail,
          subject,
          body,
          caller_consented: true,
        });
        if (!mail.ok) {
          return {
            ok: false,
            message: SMS_FAILURE_MESSAGE,
          };
        }
        ud.sessionFlags.linkSent = true;
        messages.push(`Link emailed to ${toEmail}.`);
      }

      return {
        ok: true,
        message: messages.join(' ') || 'Link sent.',
      };
    },
  });

  readonly sendRoutingFile = llm.tool({
    description:
      'Send a business file (PDF, etc.) for a matched send-file route. Creates a short-lived signed link and texts it.',
    parameters: z.object({
      routeId: z.string().min(1),
      mobilePhone: z.string().optional(),
    }),
    execute: async ({ routeId, mobilePhone }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      await maybeAcknowledgeToolStart(ctx.session as voice.AgentSession<CaraAgentUserData>);
      const resolved = resolveRouteOrFail(ud.routingLinks, routeId);
      if (!resolved.ok) {
        return resolved;
      }
      const { route } = resolved;
      if (route.targetType !== 'form' || !route.businessFileId) {
        return {
          ok: false,
          message: 'File route not found. Take a message instead.',
        };
      }
      const file = ud.businessFiles.find((f) => f.id === route.businessFileId);
      if (!file?.storage_path) {
        return {
          ok: false,
          message: 'File is not available to send. Take a message for the team.',
        };
      }
      const signed = await createBusinessFileSignedUrl(file.storage_path);
      if (!signed) {
        return {
          ok: false,
          message: 'Could not prepare the file link. Take a message for the team.',
        };
      }
      const to = resolveSmsDestination(ud, mobilePhone);
      if (!isE164SmsTarget(to)) {
        return {
          ok: false,
          message: 'Ask for a mobile number that can receive texts.',
        };
      }
      const body = `${ud.businessName} — ${file.file_name}: ${signed}`;
      const sms = await sendCallerSms(ud, to, body, 'sendRoutingFile');
      if (!sms.ok) {
        return {
          ok: false,
          message: `${sms.detail} Take a message so the team can follow up with the file.`,
        };
      }
      ud.sessionFlags.linkSent = true;
      ud.sessionFlags.smsSent += 1;
      return {
        ok: true,
        message: `File "${file.file_name}" sent. Confirm they received the text.`,
      };
    },
  });

  readonly takeCallbackMessage = llm.tool({
    description:
      'Take a message for the team (Anything else fallback or when you cannot complete the request). Creates an Action Inbox ticket. Requires the caller name — ask first, wait for their answer, then call this tool. When caller ID is on file, do NOT ask for their phone number — omit callbackPhone.',
    parameters: z.object({
      callerName: z
        .string()
        .min(2)
        .describe('Caller first name (or full name) they gave on this call.'),
      staffSummary: z
        .string()
        .min(40)
        .describe('2–5 sentences: what the caller wanted, details captured, callback preference.'),
      callbackPhone: z
        .string()
        .optional()
        .describe('Only if caller ID withheld or they gave a different callback number.'),
    }),
    execute: async ({ callerName, staffSummary, callbackPhone }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      await maybeAcknowledgeToolStart(ctx.session as voice.AgentSession<CaraAgentUserData>);
      const name = callerName.trim();
      if (!name || /^(caller|unknown|n\/a|none)$/i.test(name)) {
        return {
          ok: false,
          message: 'Ask for their name first and wait for their answer, then call takeCallbackMessage.',
        };
      }
      const text = staffSummary.trim();
      if (!text) {
        return { ok: false, message: 'Provide a fuller staffSummary.' };
      }
      return createCallbackViaWebhook(ud, text, {
        ...(callbackPhone?.trim() ? { phone: callbackPhone } : {}),
        callerName: name,
      });
    },
  });

  readonly transferToTeam = llm.tool({
    description:
      'When the caller asks to speak to a person and transfer is allowed. Logs an urgent callback if live transfer is not available.',
    parameters: z.object({
      reason: z.string().min(10).describe('Why they want a person'),
    }),
    execute: async ({ reason }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      const mode = parseCallRoutingMode(ud.callRoutingMode);
      const transfer = ud.fallbackNumber?.trim() ?? '';
      if (!callRoutingAllowsHumanTransfer(mode) || !transfer) {
        return createCallbackViaWebhook(
          ud,
          `Caller asked to speak to someone: ${reason.trim()}. Callback requested on ${ud.callerPhone}.`,
        );
      }
      ud.sessionFlags.callbackRequested = true;
      return createCallbackViaWebhook(
        ud,
        `Caller asked to speak to someone (${reason.trim()}). Transfer number on file: ${transfer}. Please call them back.`,
      );
    },
  });

  readonly sendRoutingEmail = llm.tool({
    description:
      'After matching an email route, capture caller details and log them for the team to email the route destination.',
    parameters: z.object({
      routeId: z.string().min(1),
      callerDetails: z
        .string()
        .min(20)
        .describe('Name, phone, and what they need emailed to the team'),
    }),
    execute: async ({ routeId, callerDetails }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      const resolved = resolveRouteOrFail(ud.routingLinks, routeId);
      if (!resolved.ok) {
        return resolved;
      }
      const { route } = resolved;
      if (route.targetType !== 'email' || !route.url.trim()) {
        return {
          ok: false,
          message: 'Email route not found. Take a message with takeCallbackMessage instead.',
        };
      }
      return createCallbackViaWebhook(
        ud,
        `Email ${route.url.trim()} — caller request:\n${callerDetails.trim()}`,
      );
    },
  });

  readonly sendRoutingWhatsApp = llm.tool({
    description:
      'After matching a WhatsApp route, text the caller the saved WhatsApp number or link.',
    parameters: z.object({
      routeId: z.string().min(1),
      mobilePhone: z.string().optional(),
    }),
    execute: async ({ routeId, mobilePhone }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      const resolved = resolveRouteOrFail(ud.routingLinks, routeId);
      if (!resolved.ok) {
        return resolved;
      }
      const { route } = resolved;
      if (route.targetType !== 'whatsapp' || !route.url.trim()) {
        return {
          ok: false,
          message: 'WhatsApp route not found. Take a message instead.',
        };
      }
      const to = resolveSmsDestination(ud, mobilePhone);
      if (!isE164SmsTarget(to)) {
        return {
          ok: false,
          message: 'Ask for a mobile number that can receive texts.',
        };
      }
      const body = `${ud.businessName}: WhatsApp us — ${route.url.trim()}`;
      const sms = await sendCallerSms(ud, to, body, 'sendRoutingWhatsApp');
      if (!sms.ok) {
        return createCallbackViaWebhook(
          ud,
          `Caller wants WhatsApp follow-up (${route.url.trim()}). SMS failed — please follow up. Callback: ${ud.callerPhone}.`,
        );
      }
      ud.sessionFlags.linkSent = true;
      ud.sessionFlags.smsSent += 1;
      return {
        ok: true,
        message: 'WhatsApp details sent. Confirm they received the text.',
      };
    },
  });

  readonly searchBusinessFile = llm.tool({
    description:
      'Look up a specific item, service, or price in uploaded business files (menus, price lists, brochures). Use when the caller asks about something in an uploaded document — quote only the matching excerpt, never read the whole file aloud.',
    parameters: z.object({
      query: z
        .string()
        .min(2)
        .max(500)
        .describe('What to search for — e.g. "gel manicure price" or "children haircut"'),
      fileId: z
        .string()
        .uuid()
        .optional()
        .describe('Optional business_files id when you know which file to search'),
      documentKind: z
        .enum([
          'price_list',
          'menu',
          'brochure',
          'stock_sheet',
          'service_sheet',
          'faq_doc',
          'other',
        ])
        .optional()
        .describe('Optional document type filter'),
    }),
    execute: async ({ query, fileId, documentKind }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      if (!voiceWebhooksConfigured()) {
        return {
          ok: false,
          message:
            'File lookup is not available on this call. Answer from your instructions only, or take a message.',
        };
      }

      const payload: SearchBusinessFilePayload = {
        called_number: ud.calledNumber,
        query: query.trim(),
      };
      if (fileId) payload.file_id = fileId;
      if (documentKind) payload.document_kind = documentKind;

      const result = await postSearchBusinessFile(payload);

      if (!result.ok) {
        return {
          ok: false,
          message:
            result.error ??
            'Could not search uploaded files right now. Take a message or offer to text the file if a send-file route exists.',
        };
      }

      if (result.matches.length === 0) {
        return {
          ok: true,
          message:
            'No matching excerpt found in uploaded files. Say you do not have that detail to hand — offer to text the file if available, or take a message for the team.',
          matches: [],
        };
      }

      const formatted = result.matches
        .map((match) => {
          const excerpts = match.excerpts.map((excerpt) => excerpt.text.trim()).join('\n');
          return `${match.file_name}:\n${excerpts}`;
        })
        .join('\n\n');

      return {
        ok: true,
        message: `Use only these excerpts to answer — do not read unrelated lines aloud:\n\n${formatted}`,
        matches: result.matches,
      };
    },
  });

  readonly endPhoneCall = llm.tool({
    description:
      'End the call after a short goodbye. Invoke in the same turn as your farewell — never say the tool name aloud.',
    parameters: z.object({}),
    execute: async (_args, { ctx }) => {
      const ud = readCaraUserData(ctx);
      if (
        ud.sessionFlags.assistantClaimedLinkSentSpoken &&
        !ud.sessionFlags.linkSent &&
        !ud.sessionFlags.actionTicketCreated
      ) {
        return {
          ok: false,
          message:
            'Cannot end yet — you implied the booking link was sent but SMS did not go out. Apologise, clarify, or takeCallbackMessage.',
        };
      }
      if (
        (ud.sessionFlags.askedAnythingElse || ud.sessionFlags.awaitingAnythingElseReply) &&
        !ud.sessionFlags.callerRespondedAfterAnythingElse
      ) {
        return {
          ok: false,
          message:
            'Wait for the caller to answer "anything else?" before invoking endPhoneCall.',
        };
      }
      return disconnectCallerLeg(
        ctx.session as voice.AgentSession<EndCallUserData>,
        ud,
        async () => {
          try {
            await ctx.waitForPlayout();
          } catch {
            /* ignore */
          }
        },
      );
    },
  });

  toolContext() {
    return {
      sendRoutingLink: this.sendRoutingLink,
      sendDirectionsLink: this.sendDirectionsLink,
      sendRoutingFile: this.sendRoutingFile,
      searchBusinessFile: this.searchBusinessFile,
      sendRoutingEmail: this.sendRoutingEmail,
      sendRoutingWhatsApp: this.sendRoutingWhatsApp,
      takeCallbackMessage: this.takeCallbackMessage,
      transferToTeam: this.transferToTeam,
      endPhoneCall: this.endPhoneCall,
    };
  }

  /** @deprecated Use toolContext() */
  getTools() {
    return this.toolContext();
  }

  static fallbackNote(links: RoutingLink[]): string {
    const fb = fallbackRoute(links);
    return fb?.url?.trim() || 'Name, phone number, and what they need.';
  }

  static parseLinks(raw: unknown): RoutingLink[] {
    return parseRoutingLinks(raw);
  }
}
