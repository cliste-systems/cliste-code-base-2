import { resolveSpokenBusinessName, type SpokenBusinessNameInput } from './spoken_business_name.js';

/** Warm reply to "can you hear me?" — one line so a cut-off still lands the follow-up. */
export function buildAudioCheckReply(): string {
  return "Yeah, I can hear you fine — how are you keeping?";
}

/** Caller checking the line with hello/hi — always acknowledge, never stay silent. */
export function buildLineEngagementReply(): string {
  return "Hello — I'm here, what can I do for you?";
}

const DEMO_HOST_OPENERS = [
  "I'm good thanks — sure, what brought you to Hello Cara?",
  'Not too bad at all — go on, what had you ringing?',
  "Doing well, thanks — what brought you to us?",
] as const;

/** Warm Irish reply after the greeting's "how are you keeping?" — conversational, not a pitch. */
export function buildDemoHostOpenerReply(seed = ''): string {
  const idx = pickIndex(seed.trim() || String(Date.now()), DEMO_HOST_OPENERS.length);
  return DEMO_HOST_OPENERS[idx]!;
}

const SOCIAL_CHITCHAT_REPLIES = [
  "I'm good thanks — what brought you to Hello Cara?",
  'Not too bad — what had you curious about us?',
  "I'm good thanks — go on, what brought you ringing?",
  'Doing well — what can I tell you about Hello Cara?',
] as const;

/** Warm Irish reply to "how are you keeping?" — no call-centre assist phrasing. */
export function buildSocialChitchatReply(seed = ''): string {
  const idx = pickIndex(seed.trim() || String(Date.now()), SOCIAL_CHITCHAT_REPLIES.length);
  return SOCIAL_CHITCHAT_REPLIES[idx]!;
}

const WIND_DOWN_PROMPTS = [
  'Is that everything for you?',
  'Can I help with anything else at all?',
  'Are you all sorted?',
  'Was there anything else you needed?',
  'Is there anything else I can do for you?',
  'Anything else before you go?',
] as const;

function pickIndex(seed: string, length: number): number {
  if (length <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % length;
}

/** Varied wind-down line — same job in the flow, less scripted on repeat calls. */
export function buildWindDownPrompt(seed = ''): string {
  const idx = pickIndex(seed.trim() || String(Date.now()), WIND_DOWN_PROMPTS.length);
  return WIND_DOWN_PROMPTS[idx]!;
}

export function assistantAskedWindDown(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\banything else\b/i.test(t)) return true;
  return (
    /\b(is that everything|are you all sorted|was there anything else|anything else before you go|anything else i can do)\b/i.test(
      t,
    ) && /\?/.test(t)
  );
}

/** @deprecated Use assistantAskedWindDown — kept for existing imports. */
export function assistantAskedAnythingElse(text: string): boolean {
  return assistantAskedWindDown(text);
}

type ClosingBuilder = (spokenName: string) => string;

const CLOSING_BUILDERS: ClosingBuilder[] = [
  (name) => `Lovely — thanks for ringing ${name}. Take care.`,
  (name) => `Lovely — glad I could help. Thanks for calling ${name}.`,
  (name) => `No bother at all — thanks for calling ${name}.`,
  (name) => `Perfect — thanks for calling ${name}. Have a good one.`,
  (name) => `Lovely — thanks for calling ${name}. Take care.`,
];

const DEMO_CLOSING_LINES = [
  'Lovely — thanks for trying Hello Cara. Take care.',
  'Perfect — thanks for trying Hello Cara. Have a good one.',
  'No bother — thanks for trying Hello Cara. Take care.',
] as const;

/** Programmatic close for the Hello Cara demo line after wind-down. */
export function buildDemoCallClosingLine(seed = ''): string {
  const idx = pickIndex(seed.trim() || String(Date.now()), DEMO_CLOSING_LINES.length);
  return DEMO_CLOSING_LINES[idx]!;
}

/** Demo wrap-beat question counts as wind-down for close flow. */
export function assistantAskedDemoWrap(text: string): boolean {
  const t = text.trim();
  if (!t || !/\?/.test(t)) return false;
  return /\b(another (trade|example)|are you sorted|happy enough|sorted for now)\b/i.test(t);
}

/** Warm Irish-style programmatic close — natural trade name, no bare "bye". */
export function buildWarmCallClosingLine(
  business: string | SpokenBusinessNameInput,
  seed = '',
): string {
  const name =
    typeof business === 'string'
      ? business.trim() || 'us'
      : resolveSpokenBusinessName(business);
  const idx = pickIndex(seed.trim() || name, CLOSING_BUILDERS.length);
  return CLOSING_BUILDERS[idx]!(name);
}

/** Soften abrupt one-word farewells before TTS. */
export function softenSpokenFarewell(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (/^(bye|goodbye)[!.?\s]*$/i.test(trimmed)) {
    return 'Take care.';
  }
  return trimmed
    .replace(/([.!?])?\s*\bbye[!?.]*\s*$/i, (_, punct: string | undefined) =>
      punct ? `${punct} Take care.` : 'Take care.',
    )
    .replace(/([.!?])?\s*\bgoodbye[!?.]*\s*$/i, (_, punct: string | undefined) =>
      punct ? `${punct} Take care.` : 'Take care.',
    );
}
