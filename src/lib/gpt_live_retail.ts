import * as openai from '@livekit/agents-plugin-openai';
import type { JobContext } from '@livekit/agents';
import type { RemoteParticipant } from '@livekit/rtc-node';
import { RoomServiceClient } from 'livekit-server-sdk';

import {
  ANONYMOUS_CALLER_E164,
  isAnonymousCallerE164,
  stableCallSidFallback,
} from './caller_blocklist.js';
import { maskPhone } from './gdpr.js';
import { postCallComplete } from './voice_api.js';

/** OpenAI GPT-Live Irish English feminine voice (9508 retail default). */
export const GPT_LIVE_RETAIL_VOICE_DEFAULT = 'willow';

/** Backend Responses model for tool/reasoning delegation. */
export const GPT_LIVE_RETAIL_BACKEND_DEFAULT = 'gpt-5.6-luna';

export function resolveGptLiveRetailVoice(): string {
  return process.env.CARA_GPT_LIVE_VOICE?.trim() || GPT_LIVE_RETAIL_VOICE_DEFAULT;
}

export function resolveGptLiveRetailBackendModel(): string {
  return process.env.CARA_GPT_LIVE_BACKEND_MODEL?.trim() || GPT_LIVE_RETAIL_BACKEND_DEFAULT;
}

/** Kavanaghs 9508 — full-duplex GPT-Live-1 with Irish voice only (no inference fallback). */
export function shouldUseGptLiveRetailStack(input: { conversationalRetailLine: boolean }): boolean {
  if (!input.conversationalRetailLine) return false;
  const raw = process.env.CARA_GPT_LIVE_RETAIL?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true;
}

export type ResolvedGptLiveRetailModel = {
  instance: openai.realtime.GPTLiveModel;
  label: string;
  voice: string;
  backendModel: string;
};

export function createGptLiveRetailModel(): ResolvedGptLiveRetailModel | null {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.error('[gpt_live] OPENAI_API_KEY missing — 9508 requires GPT-Live');
    return null;
  }

  const voice = resolveGptLiveRetailVoice();
  const backendModel = resolveGptLiveRetailBackendModel();

  return {
    voice,
    backendModel,
    label: `openai/gpt-live-1:${voice}+${backendModel}`,
    instance: new openai.realtime.GPTLiveModel({
      voice,
      responsesOptions: {
        model: backendModel,
        instructions:
          'Speak Irish English. Use retail lookup tools when the caller asks about products, stock, hours, or departments. Keep spoken replies concise for phone.',
      },
    }),
  };
}

export function buildGptLiveRetailOpeningInstructions(greetingText: string): string {
  const trimmed = greetingText.trim();
  return (
    'You are answering an inbound phone call. Speak Irish English. ' +
    'Say this opening exactly, naturally and warmly, then stop and listen for the caller:\n' +
    `"${trimmed}"`
  );
}

/** Drop the SIP leg when GPT-Live cannot start — no AssemblyAI/Gemma/Cartesia fallback. */
export async function rejectGptLiveUnavailableCall(input: {
  ctx: JobContext;
  participant: RemoteParticipant;
  org: { id: string; name: string; phone_number?: string | null };
  callerNumberRaw: string;
  callerE164: string;
  calledNumber: string;
  reason: string;
}): Promise<void> {
  const roomName =
    (typeof input.ctx.room.name === 'string' && input.ctx.room.name.trim()) || '';
  const callerIdentity = (input.participant.identity ?? '').trim();
  const callSid = stableCallSidFallback(input.participant, roomName);

  console.error('[gpt_live] rejecting call — GPT-Live unavailable', {
    orgId: input.org.id,
    reason: input.reason,
    callerE164: maskPhone(input.callerE164),
  });

  const host = (() => {
    const u = process.env.LIVEKIT_URL?.trim();
    if (!u) return null;
    return u.replace(/^wss?:\/\//, 'https://');
  })();
  const key = process.env.LIVEKIT_API_KEY?.trim();
  const secret = process.env.LIVEKIT_API_SECRET?.trim();
  if (host && key && secret && roomName && callerIdentity) {
    try {
      const client = new RoomServiceClient(host, key, secret);
      await client.removeParticipant(roomName, callerIdentity);
    } catch (err) {
      console.error('[gpt_live] removeParticipant failed', err);
    }
  }

  const callerForWebhook = isAnonymousCallerE164(input.callerE164)
    ? ANONYMOUS_CALLER_E164
    : input.callerNumberRaw.trim() || input.callerE164;

  try {
    await postCallComplete({
      called_number: input.calledNumber.trim() || input.org.phone_number?.trim() || '',
      call_sid: callSid,
      room_name: roomName || null,
      caller_number: callerForWebhook,
      duration_seconds: 0,
      outcome: 'gpt_live_unavailable',
      ai_summary: 'GPT-Live voice stack unavailable for this call.',
    });
  } catch (err) {
    console.error('[gpt_live] call-complete error', err);
  }
}
