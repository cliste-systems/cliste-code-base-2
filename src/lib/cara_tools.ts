import { llm, voice } from '@livekit/agents';
import { z } from 'zod';

import type { OrgVertical } from './org_vertical.js';
import type { CallPersona } from './persona.js';
import {
  callRoutingAllowsHumanTransfer,
  parseCallRoutingMode,
} from './call_routing.js';
import { maskPhone } from './gdpr.js';
import { isE164SmsTarget } from './phone_classify.js';
import {
  fallbackRoute,
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
import { playTypingSound } from './callback_audio.js';
import { disconnectCallerLeg } from './end_call.js';
import {
  isPlaceholderCallerName,
  staffSummaryLooksLikeSpeechOnlyQuestion,
} from './conversational_retail_policy.js';
import {
  inferWeeklyOffersListIntent,
  resolveCatalogSearchIntent,
  type CatalogSearchIntent,
} from './catalog_search_intent.js';
import { normalizePhoneE164 } from './phone_normalize.js';
import { sendTwilioSms, twilioSmsConfigured, caraSmsDryRunEnabled } from './twilio_sms.js';
import {
  postSendCallerEmail,
  postSearchBusinessFile,
  postSearchSupervaluProducts,
  postSearchWeeklyOffers,
  postSendSms,
  voiceWebhooksConfigured,
  type SearchBusinessFilePayload,
  type SearchSupervaluProductsPayload,
  type SearchWeeklyOffersPayload,
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
  closingCall: boolean;
  likelySttGarble: boolean;
  /** Active Hello Cara demo playbook slug (electrician, retail, …) — diagnostics only. */
  demoScenarioSlug?: string | null;
  /** 1-based beat index within the active demo playbook (1–4) — diagnostics only. */
  demoScenarioBeat?: number;
  /** Hello Cara demo — caller sounded finished; programmatic close may run. */
  demoCallerReadyToClose?: boolean;
  /** Conversational retail opening — caller first name once captured. */
  retailCallerName?: string | null;
  /** Conversational retail — recording awareness line already spoken. */
  retailRecordingNoticePlayed?: boolean;
  /** Conversational retail — opening arc finished; normal LLM flow. */
  retailOpeningComplete?: boolean;
  /** Conversational retail — Cara answered at least one caller errand post-opening. */
  retailSubstantiveExchangeComplete?: boolean;
  /** Stable retail — waiting for caller first name before callback ticket. */
  awaitingRetailCallerName?: boolean;
  /** Stable retail — summary captured when stock/price question asked. */
  pendingCallbackSummary?: string | null;
  /** Caller recently asked about weekly offers — steer catalog lookup to promo items. */
  callerAskedAboutOffers?: boolean;
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
  /** Hello Cara demo line — stricter tool and closing rules. */
  demoLine?: boolean;
  /** Kavanaghs-style retail line — programmatic wind-down and close. */
  conversationalRetailLine?: boolean;
  /** Vanilla Cartesia Siobhan baseline — no demo orchestrator or TTS sanitization. */
  factoryFreshLine?: boolean;
  /** Next session.say() should be one Cartesia synthesis (programmatic lines). */
  preparedSpeechSingleUtteranceNext?: boolean;
  endCallTarget?: { roomName: string; callerIdentity: string };
  /** Per-call conversational persona — production calls only. */
  callPersona?: CallPersona;
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

async function sendCallerLinkSms(
  ud: CaraAgentUserData,
  route: RoutingLink,
  mobilePhone?: string,
  toolName = 'sendDirectionsLink',
): Promise<{ ok: boolean; detail: string }> {
  if (ud.sessionFlags.linkSent) {
    return { ok: true, detail: 'Already sent.' };
  }
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
  const sms = await sendCallerSms(ud, to, body, toolName);
  if (!sms.ok) {
    return { ok: false, detail: sms.detail };
  }
  ud.sessionFlags.linkSent = true;
  ud.sessionFlags.smsSent += 1;
  return { ok: true, detail: 'Sent.' };
}

/** Prefer caller-line E.164 when SMS-capable; ignore LLM national-format overrides. */
function resolveSmsDestination(ud: CaraAgentUserData, mobilePhone?: string): string {
  const caller = normalizePhoneE164(ud.callerPhone);
  if (isE164SmsTarget(caller)) return caller;
  if (mobilePhone?.trim()) return normalizePhoneE164(mobilePhone);
  return caller;
}

export async function createRetailCallbackTicket(
  ud: CaraAgentUserData,
  summary: string,
  options?: { phone?: string; callerName?: string },
): Promise<{ ok: boolean; message: string }> {
  return createCallbackViaWebhook(ud, summary, options);
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
  const confirmHint = ud.conversationalRetailLine
    ? 'Speak NOW in one warm line — confirm what you logged (name, date, cake message). Do not stay silent. No tools this turn.'
    : 'Confirm what you captured in one warm spoken line, then continue the call naturally.';
  return {
    ok: true,
    message: `Message logged for the team. ${confirmHint}`,
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
        message: `Link sent for "${routeTrigger(route)}". Confirm they received it in your own words — do not reuse a confirmation line you already said this call.`,
      };
    },
  });

  readonly sendDirectionsLink = llm.tool({
    description:
      'Directions / maps links only. Say the address first, ask consent, then send.',
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
        const sms = await sendCallerLinkSms(ud, route, mobilePhone, 'sendDirectionsLink');
        if (!sms.ok) {
          return {
            ok: false,
            message: SMS_FAILURE_MESSAGE,
          };
        }
        messages.push('Maps link sent by text.');
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
        const subject = 'Directions';
        const body = `Here are directions to ${ud.businessName}:\n\n${linkUrl}`;
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
        message:
          messages.join(' ') ||
          'Link sent. Confirm they received it in your own words — vary the wording from earlier confirmations this call.',
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
        message: `File "${file.file_name}" sent. Confirm they received the text in your own words.`,
      };
    },
  });

  readonly takeCallbackMessage = llm.tool({
    description:
      'Log a cake order, stock check, complaint, or manager callback for the team. Requires the caller first name. When caller ID is on file, omit callbackPhone. Always speak to the caller in the same turn or immediately after — never a silent tool-only turn.',
    parameters: z.object({
      callerName: z
        .string()
        .min(2)
        .describe('Caller first name (or full name) they gave on this call.'),
      staffSummary: z
        .string()
        .min(1)
        .describe('2–5 sentences: what the caller wanted, details captured, callback preference.'),
      callbackPhone: z
        .string()
        .optional()
        .describe('Only if caller ID withheld or they gave a different callback number.'),
    }),
    execute: async ({ callerName, staffSummary, callbackPhone }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      if (ud.demoLine) {
        return {
          ok: false,
          message:
            'Demo line — do not take messages or invent caller names. Answer their question in speech only.',
        };
      }
      if (ud.conversationalRetailLine && staffSummaryLooksLikeSpeechOnlyQuestion(staffSummary)) {
        return {
          ok: false,
          message:
            'Opening hours and directions are answered in speech from Structured hours — do not use takeCallbackMessage. Reply with today\'s hours in one sentence.',
        };
      }
      await maybeAcknowledgeToolStart(ctx.session as voice.AgentSession<CaraAgentUserData>);
      const name =
        callerName.trim() ||
        ud.sessionFlags.retailCallerName?.trim() ||
        '';
      if (!name || isPlaceholderCallerName(name)) {
        return {
          ok: false,
          message: 'Ask for their name first and wait for their answer, then call takeCallbackMessage.',
        };
      }
      const text = staffSummary.trim();
      if (text.length < 20) {
        return {
          ok: false,
          message:
            'Provide a fuller staffSummary (at least a short sentence with what they need and any details).',
        };
      }
      playTypingSound(ctx.session);
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
        message:
          'WhatsApp details sent. Confirm they received the text in your own words — do not read the URL aloud.',
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

  readonly searchWeeklyOffers = llm.tool({
    description:
      'Look up synced **meat** weekly promotions (pre-pack rashers, sausages, pudding — not grocery). Use for specific products (steak, ham, rashers) OR when caller asks what meat offers you have / weekly offers / surprise me with the best — use query "weekly meat offers" or "meat offers this week" to list synced promos. Quote only what this tool returns.',
    parameters: z.object({
      query: z
        .string()
        .min(2)
        .max(120)
        .describe(
          'Product or browse — e.g. "striploin steak", "rashers", or "weekly meat offers" when listing all synced meat promos',
        ),
    }),
    execute: async ({ query }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      const trimmed = query.trim();
      if (
        /weetabix|cereal|bread|milk|yogurt|crisps|tayto|mayo|mayonnaise|ketchup|tea|coffee|biscuits|grocery/i.test(
          trimmed,
        ) &&
        !/meat|steak|striploin|sirloin|chicken|lamb|pork|butcher|rashers|sausage|pudding|beef/i.test(
          trimmed,
        )
      ) {
        return {
          ok: false,
          message:
            'Weekly offers sync is meat promotions only — not grocery. Use searchSuperValuProducts for this product instead.',
        };
      }
      if (!voiceWebhooksConfigured()) {
        return {
          ok: false,
          message:
            'Weekly offer lookup is not available on this call. Do not guess a price — offer the butcher or take a message.',
        };
      }

      const payload: SearchWeeklyOffersPayload = {
        called_number: ud.calledNumber,
        query: trimmed,
        channel:
          /butcher|meat counter|the counter|butchers/i.test(trimmed)
            ? 'butcher_counter'
            : /pre\s*-?\s*pack|packaged|quick fry|meat aisle/i.test(trimmed)
              ? 'prepack'
              : undefined,
      };
      let result = await postSearchWeeklyOffers(payload);

      if (
        result.ok &&
        result.matches.length === 0 &&
        !inferWeeklyOffersListIntent(trimmed)
      ) {
        result = await postSearchWeeklyOffers({
          ...payload,
          query: 'weekly meat offers',
        });
      }

      if (!result.ok) {
        return {
          ok: false,
          message:
            result.error ??
            'Could not search weekly offers right now. Offer the butcher department or take a message — do not guess.',
        };
      }

      if (result.matches.length === 0) {
        const channelHint = payload.channel === 'butcher_counter'
          ? 'No butcher counter offer found in this week\'s sync — do not quote pre-pack meat aisle deals. Offer the butcher team to confirm counter specials like multi-buy deals.'
          : payload.channel === 'prepack'
            ? 'No matching pre-pack offer found in this week\'s sync.'
            : inferWeeklyOffersListIntent(trimmed)
              ? 'No meat offers are synced this week.'
              : `No matching offer found for "${trimmed}" in this week's sync. If they asked generally what meat offers you have, retry with query "weekly meat offers".`;
        return {
          ok: true,
          message: `${channelHint} Do not invent a price — offer the butcher or take a message.`,
          matches: [],
        };
      }

      const formatted = result.matches
        .map((match) => match.quote_text.trim())
        .join('\n\n');

      return {
        ok: true,
        message: `Use only these synced offer quotes — speak prices in natural Irish words exactly as given (e.g. four euro, three for ten euro, was six euro):\n\n${formatted}`,
        matches: result.matches,
      };
    },
  });

  readonly searchSuperValuProducts = llm.tool({
    description:
      'Look up SuperValu national range products — prices, offer status, and stock guidance. When the caller asks if something is ON OFFER / this week / on special, set intent to "offer". When they ask to LIST several grocery offers (milk, bread, crisps, chocolate, fruit), pass all categories in one query with intent "offer". Quote exactly what this tool returns.',
    parameters: z.object({
      query: z
        .string()
        .min(2)
        .max(120)
        .describe('Product to search — e.g. "McVitie\'s biscuits" or "Weetabix"'),
      intent: z
        .enum(['offer', 'price', 'stock'])
        .optional()
        .describe(
          'offer = caller asking if on offer/this week/special; price = how much/cost; stock = do you stock/carry',
        ),
    }),
    execute: async ({ query, intent: explicitIntent }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      if (!voiceWebhooksConfigured()) {
        return {
          ok: false,
          message:
            'Product lookup is not available on this call. Do not guess — offer a team callback captured in speech.',
        };
      }

      const trimmed = query.trim();
      const resolvedIntent = resolveCatalogSearchIntent({
        query: trimmed,
        explicitIntent: explicitIntent as CatalogSearchIntent | undefined,
        callerAskedAboutOffers: ud.sessionFlags.callerAskedAboutOffers,
      });

      // #region agent log
      fetch('http://127.0.0.1:7662/ingest/95496c05-1739-4e32-b7be-319b56b1c5b5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0f50f3'},body:JSON.stringify({sessionId:'0f50f3',runId:'intent-fix',hypothesisId:'H3',location:'cara_tools.ts:searchSuperValuProducts',message:'catalog tool intent resolved',data:{query:trimmed,explicitIntent,resolvedIntent,callerAskedAboutOffers:ud.sessionFlags.callerAskedAboutOffers},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      const payload: SearchSupervaluProductsPayload = {
        called_number: ud.calledNumber,
        query: trimmed,
        intent: resolvedIntent,
      };
      const result = await postSearchSupervaluProducts(payload);

      // #region agent log
      fetch('http://127.0.0.1:7662/ingest/95496c05-1739-4e32-b7be-319b56b1c5b5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0f50f3'},body:JSON.stringify({sessionId:'0f50f3',runId:'grocery-browse',hypothesisId:'H1',location:'cara_tools.ts:searchSuperValuProducts',message:'catalog tool result',data:{query:trimmed,resolvedIntent,matchCount:result.ok?result.matches.length:0,browseCategories:result.browseCategories??null,firstMatch:result.ok&&result.matches[0]?{productName:result.matches[0].product_name,isOnOffer:result.matches[0].is_on_offer}:null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      if (!result.ok) {
        return {
          ok: false,
          message:
            result.error ??
            'Could not search the SuperValu range right now. Offer a team callback captured in speech — do not guess.',
        };
      }

      if (result.matches.length === 0) {
        return {
          ok: true,
          message:
            result.noMatchQuote ??
            'No matching product found on the SuperValu range — do not claim we stock it. Offer a team callback to confirm.',
          matches: [],
        };
      }

      const formatted = result.matches
        .map((match) => match.quote_text.trim())
        .join('\n\n');

      return {
        ok: true,
        message: `Use this guidance — speak prices in natural Irish words exactly as given (e.g. four euro seventy nine, three for ten euro), in your own words:\n\n${formatted}`,
        matches: result.matches,
      };
    },
  });

  readonly endPhoneCall = llm.tool({
    description:
      'End the call after a warm Irish goodbye (e.g. "Lovely — thanks for calling Kavanaghs SuperValu Donegal Town. Take care." or "Lovely — thanks for calling Murphy\'s SuperValu. Take care."). Invoke in the same turn as your farewell — never abrupt "ok bye", bare "bye", or "grand". On the Hello Cara demo line: after "is that everything?" and they confirm, give the outro ("Lovely, {name} — thanks for calling Hello Cara today. Have a good day/evening. Bye for now.") then call this tool in that same turn; never say "grand" or "sound"; do not ask another question after they wind down. On Kavanaghs 9508 (conversational retail): any spoken farewell ("have a great day", "take care", "thanks for calling") MUST invoke this tool in that same turn — never leave a dangling goodbye. After beat 1, if the caller is done → outro + this tool; no third question.',
    parameters: z.object({}),
    execute: async (_args, { ctx }) => {
      const ud = readCaraUserData(ctx);
      if (ud.demoLine) {
        return disconnectCallerLeg(
          ctx.session,
          ud,
          async () => {
            try {
              await ctx.waitForPlayout();
            } catch {
              /* ignore */
            }
          },
        );
      }
      if (ud.conversationalRetailLine) {
        return disconnectCallerLeg(
          ctx.session,
          ud,
          async () => {
            try {
              await ctx.waitForPlayout();
            } catch {
              /* ignore */
            }
          },
        );
      }
      if (
        (ud.sessionFlags.askedAnythingElse || ud.sessionFlags.awaitingAnythingElseReply) &&
        !ud.sessionFlags.callerRespondedAfterAnythingElse
      ) {
        return {
          ok: false,
          message:
            'Wait for the caller to answer your wind-down question before invoking endPhoneCall.',
        };
      }
      return disconnectCallerLeg(
        ctx.session,
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

  toolContext(options?: {
    vertical?: OrgVertical;
    demoLine?: boolean;
    conversationalRetailLine?: boolean;
  }) {
    if (options?.demoLine) {
      return {
        endPhoneCall: this.endPhoneCall,
      };
    }
    if (options?.conversationalRetailLine) {
      return {
        endPhoneCall: this.endPhoneCall,
        searchWeeklyOffers: this.searchWeeklyOffers,
        searchSuperValuProducts: this.searchSuperValuProducts,
      };
    }
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
