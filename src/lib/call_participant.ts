import type { JobContext } from '@livekit/agents';
import type { RemoteParticipant } from '@livekit/rtc-node';
import { RoomServiceClient } from 'livekit-server-sdk';

import { greetingIncludesAiDisclosure } from './greeting_compliance.js';

const DEFAULT_TEST_PHONE = '+15551234567';

export type RoutingHint = { slug?: string; phone?: string };

function parseMetadataRouting(metadata: string): RoutingHint {
  if (!metadata.trim()) return {};
  try {
    const p = JSON.parse(metadata) as Record<string, unknown>;
    const slugRaw = p.organization_slug ?? p.salon_slug ?? p.slug;
    const slug = typeof slugRaw === 'string' ? slugRaw.trim() : undefined;
    const phoneRaw =
      p.phone_number ?? p.dialedNumber ?? p.trunkPhoneNumber ?? p.trunk_phone_number;
    const phone = typeof phoneRaw === 'string' ? phoneRaw.trim() : undefined;
    const hint: RoutingHint = {};
    if (slug) hint.slug = slug;
    if (phone) hint.phone = phone;
    return hint;
  } catch {
    return {};
  }
}

function routingFromParticipantAttributes(attrs: Record<string, string>): RoutingHint {
  let slug: string | undefined;
  for (const key of ['organization_slug', 'salon_slug', 'slug'] as const) {
    const v = attrs[key];
    if (v?.trim()) {
      slug = v.trim();
      break;
    }
  }
  const sip = attrs['sip.trunkPhoneNumber'] ?? attrs['sip.trunk_phone_number'];
  const phone = sip?.trim();
  const hint: RoutingHint = {};
  if (slug) hint.slug = slug;
  if (phone) hint.phone = phone;
  return hint;
}

export function resolveOrgRouting(
  job: JobContext['job'],
  participant: RemoteParticipant,
): RoutingHint {
  const jobM = parseMetadataRouting(job.metadata ?? '');
  const roomM = job.room?.metadata ? parseMetadataRouting(job.room.metadata) : {};
  const part = routingFromParticipantAttributes(participant.attributes);

  const slug =
    jobM.slug ??
    roomM.slug ??
    part.slug ??
    process.env.DEFAULT_ORG_SLUG?.trim() ??
    process.env.DEFAULT_SALON_SLUG?.trim() ??
    undefined;

  const phone =
    part.phone ??
    jobM.phone ??
    roomM.phone ??
    process.env.DEFAULT_ORG_PHONE?.trim() ??
    process.env.DEFAULT_SALON_PHONE?.trim() ??
    DEFAULT_TEST_PHONE;

  const hint: RoutingHint = {};
  if (slug) hint.slug = slug;
  hint.phone = phone;
  return hint;
}

export function callerNumberFromParticipant(participant: RemoteParticipant): string {
  const id = (participant.identity ?? '').trim();
  if (id.toLowerCase().startsWith('sip_')) {
    const rest = id.slice(4).trim();
    if (rest.startsWith('+')) return rest;
    const digits = rest.replace(/\D/g, '');
    return digits ? `+${digits}` : rest || 'unknown';
  }
  const attrs = participant.attributes ?? {};
  const sip =
    attrs['sip.phoneNumber'] ??
    attrs['sip.trunkPhoneNumber'] ??
    attrs['sip.trunk_phone_number'] ??
    '';
  const t = sip.trim();
  if (t.startsWith('+')) return t;
  const d = t.replace(/\D/g, '');
  if (d.length >= 10) return `+${d}`;
  const fromIdentity = id.replace(/\D/g, '');
  if (fromIdentity.length >= 10) return `+${fromIdentity}`;
  return id || 'unknown';
}

export function resolveCalledNumber(
  routingPhone: string | undefined,
  orgPhone: string | null | undefined,
): string {
  return routingPhone?.trim() || orgPhone?.trim() || '';
}

export async function disconnectParticipant(roomName: string, identity: string): Promise<void> {
  const lkHost = process.env.LIVEKIT_URL?.trim();
  const lkKey = process.env.LIVEKIT_API_KEY?.trim();
  const lkSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!lkHost || !lkKey || !lkSecret || !roomName || !identity) return;
  const httpsHost = lkHost.replace(/^wss?:\/\//, 'https://');
  const client = new RoomServiceClient(httpsHost, lkKey, lkSecret);
  await client.removeParticipant(roomName, identity);
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export function resolveElevenVoiceSettings(): {
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
  use_speaker_boost: boolean;
} {
  // Natural conversation sits at 0.9–1.1 (ElevenLabs); default 1.0 for phone clarity.
  const speed = Math.min(
    Math.max(Number.parseFloat(process.env.ELEVEN_VOICE_SPEED ?? '1.0') || 1.0, 0.7),
    1.2,
  );
  return {
    // Phone: higher stability + lower style = tighter, less roomy/shouty on turbo.
    stability: Number.parseFloat(process.env.ELEVEN_VOICE_STABILITY ?? '0.55') || 0.55,
    similarity_boost: Number.parseFloat(process.env.ELEVEN_VOICE_SIMILARITY ?? '0.78') || 0.78,
    style: Number.parseFloat(process.env.ELEVEN_VOICE_STYLE ?? '0.20') || 0.2,
    speed,
    // Speaker boost adds latency and can flatten prosody — default off, env-overridable.
    use_speaker_boost: envBool('ELEVEN_VOICE_SPEAKER_BOOST', false),
  };
}

export function voiceSettingsCacheFingerprint(settings: {
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
}): string {
  return `${settings.stability}|${settings.similarity_boost}|${settings.style}|${settings.speed}`;
}

export function buildGreetingSpeech(orgName: string, orgGreeting: string | null | undefined): string {
  const base =
    orgGreeting?.trim() || `Thanks for calling ${orgName}. How can I help you today?`;
  if (greetingIncludesAiDisclosure(base)) return base;
  return `${base} I'm Cara, the AI assistant. This call may be recorded and transcribed.`;
}
