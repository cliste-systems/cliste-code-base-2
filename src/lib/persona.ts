/**
 * Per-call conversational variety — manner, greeting, acknowledgements, sign-off.
 * Seeded from org + caller + room so one call is reproducible; consecutive callers differ.
 */

export type CallPersona = {
  variant: string;
  manner: string;
  greeting: string;
  acknowledgements: string[];
  signOff: string;
};

export type PickCallPersonaInput = {
  businessName: string;
  seed: string;
  localHour?: number;
};

const MANNERS = [
  'Warm but brisk today — you are busy behind the desk, and you still have time for whoever is on the line.',
  'Easy-going today — a little more chat in you than usual, never rushing anyone off the phone.',
  'Friendly and efficient today — upbeat, quick on your feet, never curt.',
  'Calm and reassuring today — unhurried, the sort of voice that makes people feel looked after.',
  'Cheerful and chatty today — quick to laugh along in words, quick to get them sorted.',
  'Down-to-earth and practical today — no fuss, plain talk, genuinely helpful.',
] as const;

const GREETING_TEMPLATES = [
  '{business}, how can I help?',
  'Hi there, {business} — what can I do for you?',
  'Good {timeOfDay}, {business} — how can I help you today?',
  '{business}, hi — how can I help?',
  "Hello, you're through to {business} — how can I help?",
  'Good {timeOfDay}, {business} — what can I do for you?',
] as const;

const ACKNOWLEDGEMENT_SETS = [
  ['Grand', 'Right so', 'Lovely', 'No bother'],
  ['Perfect', 'Okay', 'Brilliant', 'Sure'],
  ['Right', 'Grand so', 'Gotcha', 'Lovely stuff'],
  ['Okay', 'Ah grand', 'Perfect', 'Right you are'],
  ['Lovely', 'No bother at all', 'Grand', 'Of course'],
  ['Brilliant', 'Right', 'Sound', 'Grand so'],
] as const;

const SIGN_OFF_TEMPLATES = [
  '{name}, thanks for ringing — see you {date}!',
  'Grand, {name} — see you {date}, take care!',
  'Lovely, {name} — we\'ll see you {date}. Bye now!',
  'That\'s you sorted, {name} — see you {date}!',
  'Perfect, {name} — see you {date}, thanks a million!',
  'Grand so, {name} — see you {date}. All the best!',
] as const;

const BANK_PREFIXES = ['manner', 'greeting', 'ack', 'signoff'] as const;

/** FNV-1a with murmur3-style final avalanche — `% 6` must not read weak low bits. */
export function hashPersonaSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function resolveTimeOfDay(localHour?: number): string {
  if (localHour == null || !Number.isFinite(localHour)) return 'afternoon';
  if (localHour < 12) return 'morning';
  if (localHour < 17) return 'afternoon';
  return 'evening';
}

export function personaVarietyEnabled(): boolean {
  const raw =
    process.env.CARA_PERSONA_VARIETY?.trim() ||
    process.env.SALON_PERSONA_VARIETY?.trim() ||
    'on';
  const v = raw.toLowerCase();
  return !(['off', 'false', '0', 'no'].includes(v));
}

function pickBankIndex(seed: string, bankPrefix: string, bankSize: number): number {
  if (bankSize <= 0) return 0;
  const h = hashPersonaSeed(`${bankPrefix}:${seed}`);
  return h % bankSize;
}

function interpolateGreeting(template: string, businessName: string, timeOfDay: string): string {
  return template
    .replace(/\{business\}/g, businessName)
    .replace(/\{salon\}/g, businessName)
    .replace(/\{timeOfDay\}/g, timeOfDay);
}

export function pickCallPersona(input: PickCallPersonaInput): CallPersona {
  const businessName = input.businessName.trim() || 'us';
  const seed = input.seed.trim() || businessName;
  const timeOfDay = resolveTimeOfDay(input.localHour);
  const pinned = !personaVarietyEnabled();

  const mannerIdx = pinned ? 0 : pickBankIndex(seed, BANK_PREFIXES[0], MANNERS.length);
  const greetingIdx = pinned ? 0 : pickBankIndex(seed, BANK_PREFIXES[1], GREETING_TEMPLATES.length);
  const ackIdx = pinned ? 0 : pickBankIndex(seed, BANK_PREFIXES[2], ACKNOWLEDGEMENT_SETS.length);
  const signOffIdx = pinned ? 0 : pickBankIndex(seed, BANK_PREFIXES[3], SIGN_OFF_TEMPLATES.length);

  const greeting = interpolateGreeting(GREETING_TEMPLATES[greetingIdx]!, businessName, timeOfDay);

  return {
    variant: `${mannerIdx}-${greetingIdx}-${ackIdx}-${signOffIdx}`,
    manner: MANNERS[mannerIdx]!,
    greeting,
    acknowledgements: [...ACKNOWLEDGEMENT_SETS[ackIdx]!],
    signOff: SIGN_OFF_TEMPLATES[signOffIdx]!,
  };
}

/** Empirical spread check — exported for tests and preview script. */
export function buildDemoPersonaGreeting(persona: CallPersona, seed: string): string {
  const nameAsks = [
    'Can I get your name?',
    'Can I get your name please?',
    'Who am I speaking to?',
    "Who's calling?",
  ] as const;
  const idx = pickBankIndex(seed, 'demo_name_ask', nameAsks.length);
  return `${persona.greeting} — ${nameAsks[idx]!}`;
}

export function measurePersonaSpread(sampleCount: number): {
  distinctVariants: number;
  bankCounts: { manner: number[]; greeting: number[]; ack: number[]; signoff: number[] };
} {
  const variants = new Set<string>();
  const bankCounts = {
    manner: Array.from({ length: MANNERS.length }, () => 0),
    greeting: Array.from({ length: GREETING_TEMPLATES.length }, () => 0),
    ack: Array.from({ length: ACKNOWLEDGEMENT_SETS.length }, () => 0),
    signoff: Array.from({ length: SIGN_OFF_TEMPLATES.length }, () => 0),
  };

  for (let i = 0; i < sampleCount; i += 1) {
    const p = pickCallPersona({
      businessName: 'Example Business',
      seed: `org-${i}:+35387${String(i).padStart(7, '0')}:room-${i % 97}`,
      localHour: i % 24,
    });
    variants.add(p.variant);
    const [m, g, a, s] = p.variant.split('-').map((x) => Number.parseInt(x, 10));
    if (Number.isFinite(m) && m >= 0 && m < bankCounts.manner.length) bankCounts.manner[m]! += 1;
    if (Number.isFinite(g) && g >= 0 && g < bankCounts.greeting.length) bankCounts.greeting[g]! += 1;
    if (Number.isFinite(a) && a >= 0 && a < bankCounts.ack.length) bankCounts.ack[a]! += 1;
    if (Number.isFinite(s) && s >= 0 && s < bankCounts.signoff.length) bankCounts.signoff[s]! += 1;
  }

  return { distinctVariants: variants.size, bankCounts };
}
