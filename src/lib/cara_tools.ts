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
import {
  postSendCallerEmail,
  postSearchBusinessFile,
  postSendSms,
  voiceWebhooksConfigured,
  type SearchBusinessFilePayload,
} from './voice_api.js';

export type CaraSessionFlags = {
  linkSent: boolean;
  actionTicketCreated: boolean;
  callbackRequested: boolean;
  smsSent: number;
  endPhoneCallUsed: boolean;
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
  session: voice.AgentSession<CaraAgentUserData>,
): Promise<void> {
  try {
    if (session.userData.sessionFlags.endPhoneCallUsed) return;
    if (session.agentState === 'speaking' || session.userState === 'speaking') return;
    session.say('Just a moment.');
  } catch {
    /* ignore */
  }
}

async function sendCallerSms(
  ud: CaraAgentUserData,
  to: string,
  body: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!voiceWebhooksConfigured()) {
    return { ok: false, detail: 'SMS is not configured on this worker.' };
  }
  if (!ud.calledNumber.trim()) {
    return { ok: false, detail: 'Missing dialed number for SMS routing.' };
  }
  const result = await postSendSms({
    called_number: ud.calledNumber,
    to,
    body,
    caller_consented: true,
    skip_business_prefix: true,
  });
  if (!result.ok) {
    return { ok: false, detail: result.error ?? 'SMS send failed.' };
  }
  return { ok: true, detail: 'Sent.' };
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
        .describe('SMS-capable mobile in E.164 or Irish national. Omit to use caller line if mobile.'),
    }),
    execute: async ({ routeId, mobilePhone }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      await maybeAcknowledgeToolStart(ctx.session as voice.AgentSession<CaraAgentUserData>);
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
      let to = mobilePhone?.trim()
        ? normalizePhoneE164(mobilePhone)
        : normalizePhoneE164(ud.callerPhone);
      if (!isE164SmsTarget(to)) {
        return {
          ok: false,
          message:
            'Ask for an SMS-capable mobile number, then retry. Landlines cannot receive texts.',
        };
      }
      const body = `${ud.businessName}: ${route.url.trim()}`;
      const sms = await sendCallerSms(ud, to, body);
      if (!sms.ok) {
        return {
          ok: false,
          message: `${sms.detail} Read the link aloud: ${route.url.trim()}`,
        };
      }
      ud.sessionFlags.linkSent = true;
      ud.sessionFlags.smsSent += 1;
      console.log('sendRoutingLink', {
        orgId: ud.organizationId,
        routeId,
        to: maskPhone(to),
      });
      return {
        ok: true,
        message: `Link sent for "${routeTrigger(route)}". Confirm it was received.`,
      };
    },
  });

  readonly sendDirectionsLink = llm.tool({
    description:
      'For booking or directions routes with text/email delivery configured. For directions, say the address first. Then ask how they want the link and send by SMS and/or email per the route setup.',
    parameters: z.object({
      routeId: z.string().min(1).describe('The routing_links id for the route'),
      channel: z
        .enum(['sms', 'email'])
        .describe('How to send the maps link — match the route and what the caller chose'),
      mobilePhone: z
        .string()
        .optional()
        .describe('SMS-capable mobile. Omit to use caller line when it can receive texts.'),
      emailAddress: z
        .string()
        .optional()
        .describe('Caller email — required for email channel; ask on landlines.'),
      callerConsented: z
        .boolean()
        .describe('True after the caller agreed to receive the link this way on the call'),
    }),
    execute: async (
      { routeId, channel, mobilePhone, emailAddress, callerConsented },
      { ctx },
    ) => {
      const ud = readCaraUserData(ctx);
      await maybeAcknowledgeToolStart(ctx.session as voice.AgentSession<CaraAgentUserData>);
      const resolved = resolveRouteOrFail(ud.routingLinks, routeId);
      if (!resolved.ok) {
        return resolved;
      }
      const { route } = resolved;
      if (!routeUsesCallerLinkDelivery(route) || !route.url.trim()) {
        return {
          ok: false,
          message:
            'Route not found or link delivery is not configured. Use sendRoutingLink for simple link routes, or take a message.',
        };
      }
      if (!callerConsented) {
        return {
          ok: false,
          message: 'Ask the caller if you may send the link, then retry with callerConsented true.',
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
        let to = mobilePhone?.trim()
          ? normalizePhoneE164(mobilePhone)
          : normalizePhoneE164(ud.callerPhone);
        if (!isE164SmsTarget(to)) {
          return {
            ok: false,
            message:
              'This line cannot receive texts. Ask for a mobile number, or offer email instead.',
          };
        }
        const body = `${smsPrefix}${linkUrl}`;
        const sms = await sendCallerSms(ud, to, body);
        if (!sms.ok) {
          return {
            ok: false,
            message: `${sms.detail} Read the link aloud: ${linkUrl}`,
          };
        }
        ud.sessionFlags.linkSent = true;
        ud.sessionFlags.smsSent += 1;
        messages.push(isLocationRoute(route) ? 'Maps link sent by text.' : 'Booking link sent by text.');
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
            message: `Email is not available — read the link aloud: ${linkUrl}`,
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
            message: `${mail.error ?? 'Email failed'} — read the link aloud: ${linkUrl}`,
          };
        }
        ud.sessionFlags.linkSent = true;
        messages.push(`Link emailed to ${toEmail}.`);
      }

      console.log('sendDirectionsLink', {
        orgId: ud.organizationId,
        routeId,
        channel,
      });

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
      let to = mobilePhone?.trim()
        ? normalizePhoneE164(mobilePhone)
        : normalizePhoneE164(ud.callerPhone);
      if (!isE164SmsTarget(to)) {
        return {
          ok: false,
          message: 'Ask for a mobile number that can receive texts.',
        };
      }
      const body = `${ud.businessName} — ${file.file_name}: ${signed}`;
      const sms = await sendCallerSms(ud, to, body);
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
      'Take a message for the team (Anything else fallback or when you cannot complete the request). Creates an Action Inbox ticket. Requires the caller name — ask first, wait for their answer, then call this tool.',
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
      let to = mobilePhone?.trim()
        ? normalizePhoneE164(mobilePhone)
        : normalizePhoneE164(ud.callerPhone);
      if (!isE164SmsTarget(to)) {
        return {
          ok: false,
          message: 'Ask for a mobile number that can receive texts.',
        };
      }
      const body = `${ud.businessName}: WhatsApp us — ${route.url.trim()}`;
      const sms = await sendCallerSms(ud, to, body);
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
