/**
 * Inbound caller blocklist — dashboard writes `blocked_callers`; worker
 * enforces before starting Cara (VOICE-WORKER-CONTRACT Blocklist gate).
 */
import type { JobContext } from '@livekit/agents';
import { voice } from '@livekit/agents';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as silero from '@livekit/agents-plugin-silero';
import type { RemoteParticipant } from '@livekit/rtc-node';
import { RoomServiceClient } from 'livekit-server-sdk';

import { createElevenLabsTts } from './elevenlabs-v3-http-tts.js';
import { prepareHardcodedSpeechForTts } from './tts_text_sanitize.js';
import { maskPhone } from './gdpr.js';
import { classifyCallerLine } from './phone_classify.js';
import {
  getSupabaseClient,
  isOfflinePlayground,
  resolveOrgVoiceId,
  type OrgCallConfig,
} from './supabase.js';
import { postCallComplete } from './voice_api.js';

export const ANONYMOUS_CALLER_E164 = '+anonymous';

export function blockedCallSpokenMessage(businessName: string): string {
  const name = businessName.trim() || 'this business';
  return `We're unable to put you through to ${name}. This line is operated by Hello Cara, and your number isn't authorised to connect. Goodbye.`;
}

export function blockedCallDashboardSummary(businessName: string): string {
  const name = businessName.trim() || 'your business';
  return `This caller tried to reach ${name}, but their number is on your blocklist. Hello Cara stopped the call before Cara could answer.`;
}

const E164_RE = /^\+\d{8,16}$/;

/** Map SIP / withheld identities to the blocklist key the dashboard uses. */
export function callerE164ForBlocklist(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  const lower = trimmed.toLowerCase();
  if (
    !trimmed ||
    lower === 'unknown' ||
    lower === 'anonymous' ||
    lower === 'restricted' ||
    lower === 'private' ||
    lower === 'unavailable' ||
    lower.includes('withheld')
  ) {
    return ANONYMOUS_CALLER_E164;
  }

  const classified = classifyCallerLine(trimmed);
  if (classified.e164 && E164_RE.test(classified.e164)) {
    return classified.e164;
  }

  let candidate = trimmed.replace(/^sip[:_]/i, '');
  if (!candidate.startsWith('+')) {
    const digits = candidate.replace(/\D/g, '');
    if (digits.startsWith('0') && digits.length >= 10 && digits.length <= 11) {
      candidate = `+353${digits.slice(1)}`;
    } else if (digits.startsWith('353') && digits.length >= 11) {
      candidate = `+${digits}`;
    } else if (digits.length >= 8) {
      candidate = `+${digits}`;
    }
  }

  if (E164_RE.test(candidate)) {
    return candidate;
  }

  return ANONYMOUS_CALLER_E164;
}

export function isAnonymousCallerE164(callerE164: string): boolean {
  return callerE164.trim() === ANONYMOUS_CALLER_E164;
}

export type BlocklistCheckResult = 'allowed' | 'blocked' | 'lookup_failed';

export async function checkCallerBlocklist(input: {
  organizationId: string;
  callerE164: string;
  blockAnonymous: boolean;
}): Promise<BlocklistCheckResult> {
  if (isOfflinePlayground()) return 'allowed';
  if (isAnonymousCallerE164(input.callerE164)) {
    return input.blockAnonymous ? 'blocked' : 'allowed';
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('blocked_callers')
    .select('id')
    .eq('organization_id', input.organizationId)
    .eq('caller_e164', input.callerE164)
    .maybeSingle();

  if (error) {
    console.error('[caller_blocklist] lookup failed — fail closed', error.message);
    return 'lookup_failed';
  }

  return data?.id ? 'blocked' : 'allowed';
}

/** @deprecated Use checkCallerBlocklist */
export async function isCallerBlocked(input: {
  organizationId: string;
  callerE164: string;
  blockAnonymous: boolean;
}): Promise<boolean> {
  const result = await checkCallerBlocklist(input);
  return result !== 'allowed';
}

function waitForSpeechPlayout(handle: {
  done(): boolean;
  addDoneCallback: (cb: (sh: unknown) => void) => void;
}): Promise<void> {
  if (handle.done()) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Blocked-call message playout timed out')), 25_000);
    handle.addDoneCallback(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

function livekitHttpsHost(): string | null {
  const u = process.env.LIVEKIT_URL?.trim();
  if (!u) return null;
  return u.replace(/^wss?:\/\//, 'https://');
}

export function callSidFromParticipant(participant: RemoteParticipant): string | null {
  const attrs = participant.attributes ?? {};
  const sid =
    attrs['sip.callID'] ??
    attrs['sip.callId'] ??
    attrs['sip.call_id'] ??
    '';
  return sid.trim() || null;
}

/** Stable id for call-complete when SIP callID attrs are missing. */
export function stableCallSidFallback(
  participant: RemoteParticipant,
  roomName: string,
): string | null {
  const sid = callSidFromParticipant(participant);
  if (sid) return sid;
  const identity = (participant.identity ?? '').trim();
  if (roomName && identity) {
    return `${roomName}:${identity}`.slice(0, 128);
  }
  return roomName.trim() || null;
}

function createBlockRejectTts(org: OrgCallConfig) {
  const elevenApiKey =
    process.env.ELEVEN_API_KEY?.trim() || process.env.ELEVENLABS_API_KEY?.trim() || '';
  if (!elevenApiKey) {
    return null;
  }
  const voiceId =
    resolveOrgVoiceId(org) ||
    process.env.ELEVEN_VOICE_ID?.trim() ||
    'C92s6vssSLlabgIln1iY';
  const model = process.env.ELEVEN_TTS_MODEL?.trim() || 'eleven_flash_v2_5';
  const encoding = process.env.ELEVEN_TTS_ENCODING?.trim() || 'pcm_24000';
  const baseURL =
    process.env.ELEVENLABS_BASE_URL?.trim() || 'https://api.elevenlabs.io/v1';

  return createElevenLabsTts({
    apiKey: elevenApiKey,
    voiceId,
    model,
    encoding: encoding as elevenlabs.TTSEncoding,
    baseURL,
    streamingLatency: 0,
    voiceSettings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.35,
      use_speaker_boost: true,
    },
  });
}

/** Play the block clip, drop the SIP leg, and log `outcome: blocked`. */
export async function rejectBlockedCaller(input: {
  ctx: JobContext;
  participant: RemoteParticipant;
  org: OrgCallConfig;
  callerNumberRaw: string;
  callerE164: string;
  calledNumber: string;
}): Promise<void> {
  const roomName =
    (typeof input.ctx.room.name === 'string' && input.ctx.room.name.trim()) || '';
  const callerIdentity = (input.participant.identity ?? '').trim();
  const callSid = stableCallSidFallback(input.participant, roomName);

  const tts = createBlockRejectTts(input.org);
  const vad = input.ctx.proc.userData.vad;
  const spokenMessage = blockedCallSpokenMessage(input.org.name);

  if (tts && vad) {
    const session = new voice.AgentSession({
      tts,
      vad: vad as silero.VAD,
    });
    try {
      await session.start({
        agent: new voice.Agent({ instructions: ' ' }),
        room: input.ctx.room,
      });
      const handle = session.say(prepareHardcodedSpeechForTts(spokenMessage), {
        allowInterruptions: false,
      });
      await waitForSpeechPlayout(handle);
    } catch (err) {
      console.error('[caller_blocklist] block message TTS failed', err);
    } finally {
      try {
        await session.close();
      } catch {
        /* ignore */
      }
      try {
        await tts.close();
      } catch {
        /* ignore */
      }
    }
  } else {
    console.warn('[caller_blocklist] skipping block message — TTS or VAD unavailable');
  }

  const host = livekitHttpsHost();
  const key = process.env.LIVEKIT_API_KEY?.trim();
  const secret = process.env.LIVEKIT_API_SECRET?.trim();
  if (host && key && secret && roomName && callerIdentity) {
    try {
      const client = new RoomServiceClient(host, key, secret);
      await client.removeParticipant(roomName, callerIdentity);
    } catch (err) {
      console.error('[caller_blocklist] removeParticipant failed', err);
    }
  }

  const callerForWebhook = isAnonymousCallerE164(input.callerE164)
    ? ANONYMOUS_CALLER_E164
    : input.callerNumberRaw.trim() || input.callerE164;

  try {
    const result = await postCallComplete({
      called_number: input.calledNumber.trim() || input.org.phone_number?.trim() || '',
      call_sid: callSid,
      room_name: roomName || null,
      caller_number: callerForWebhook,
      duration_seconds: 0,
      outcome: 'blocked',
      ai_summary: blockedCallDashboardSummary(input.org.name),
    });
    if (!result.ok) {
      console.warn('[caller_blocklist] call-complete failed', result.error);
    }
  } catch (err) {
    console.error('[caller_blocklist] call-complete error', err);
  }

  console.info('[caller_blocklist] rejected blocked caller', {
    orgId: input.org.id,
    callerE164: maskPhone(input.callerE164),
  });
}
