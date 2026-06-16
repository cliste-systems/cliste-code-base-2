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
  parseRoutingLinks,
  routeTrigger,
  type RoutingLink,
} from './routing_links.js';
import {
  createBusinessFileSignedUrl,
  type BusinessFileRow,
} from './supabase.js';
import { normalizePhoneE164, sendSms } from './sms.js';
import { insertActionTicket } from './action_tickets.js';
import { disconnectSalonCallerLeg, type EndCallUserData } from './tools.js';

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

function findRouteById(links: RoutingLink[], routeId: string): RoutingLink | null {
  const id = routeId.trim();
  return links.find((r) => r.id === id) ?? null;
}

async function createCallbackViaWebhook(
  ud: CaraAgentUserData,
  summary: string,
  phone?: string,
): Promise<{ ok: boolean; message: string }> {
  const caller = phone?.trim()
    ? normalizePhoneE164(phone)
    : ud.callerPhone.trim() || 'unknown';

  await insertActionTicket({
    organizationId: ud.organizationId,
    calledNumber: ud.calledNumber,
    callerNumber: caller,
    summary,
    engineeringPriority: 'urgent',
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
      const route = findRouteById(ud.routingLinks, routeId);
      if (!route || route.targetType !== 'link' || !route.url.trim()) {
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
      const sms = await sendSms(to, body);
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

  readonly sendRoutingFile = llm.tool({
    description:
      'Send a business file (PDF, etc.) for a matched send-file route. Creates a short-lived signed link and texts it.',
    parameters: z.object({
      routeId: z.string().min(1),
      mobilePhone: z.string().optional(),
    }),
    execute: async ({ routeId, mobilePhone }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      const route = findRouteById(ud.routingLinks, routeId);
      if (!route || route.targetType !== 'form' || !route.businessFileId) {
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
      const sms = await sendSms(to, body);
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
      'Take a message for the team (Anything else fallback or when you cannot complete the request). Creates an Action Inbox ticket.',
    parameters: z.object({
      staffSummary: z
        .string()
        .min(40)
        .describe('2–5 sentences: what the caller wanted, details captured, callback preference.'),
      callbackPhone: z.string().optional(),
    }),
    execute: async ({ staffSummary, callbackPhone }, { ctx }) => {
      const ud = readCaraUserData(ctx);
      const text = staffSummary.trim();
      if (!text) {
        return { ok: false, message: 'Provide a fuller staffSummary.' };
      }
      return createCallbackViaWebhook(ud, text, callbackPhone);
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
      const route = findRouteById(ud.routingLinks, routeId);
      if (!route || route.targetType !== 'email' || !route.url.trim()) {
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
      const route = findRouteById(ud.routingLinks, routeId);
      if (!route || route.targetType !== 'whatsapp' || !route.url.trim()) {
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
      const sms = await sendSms(to, body);
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

  readonly endPhoneCall = llm.tool({
    description:
      'End the call after a short goodbye. Invoke in the same turn as your farewell — never say the tool name aloud.',
    parameters: z.object({}),
    execute: async (_args, { ctx }) => {
      const ud = readCaraUserData(ctx);
      return disconnectSalonCallerLeg(
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
      sendRoutingFile: this.sendRoutingFile,
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
