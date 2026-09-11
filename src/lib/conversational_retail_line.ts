import { normalizePhoneE164 } from './phone_normalize.js';
import { resolveSpokenBusinessName } from './spoken_business_name.js';

/** Retail demo lines that use the Hello Cara conversational opening stack. */
const DEFAULT_CONVERSATIONAL_RETAIL_NUMBERS = ['+353749759508'];

function conversationalRetailNumberSet(): Set<string> {
  const fromEnv = (process.env.CARA_CONVERSATIONAL_RETAIL_CALLED_NUMBERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set<string>();
  for (const raw of [...DEFAULT_CONVERSATIONAL_RETAIL_NUMBERS, ...fromEnv]) {
    set.add(raw.trim());
    const normalized = normalizePhoneE164(raw);
    if (normalized) set.add(normalized);
  }
  return set;
}

/** Kavanaghs-style retail line — demo conversational feel, production retail tools. */
export function isConversationalRetailLine(calledNumber: string | null | undefined): boolean {
  const t = calledNumber?.trim();
  if (!t) return false;
  const set = conversationalRetailNumberSet();
  if (set.has(t)) return true;
  const normalized = normalizePhoneE164(t);
  return normalized ? set.has(normalized) : false;
}

/** Silence before the Kavanaghs retail opening plays (ms). */
export const RETAIL_LINE_OPENING_PAUSE_MS = 1600;

export function buildRetailConversationalOpening(spokenBusinessName: string): string {
  const name = spokenBusinessName.trim() || 'the store';
  return `Hello, you're through to ${name}. I'm Cara, the AI assistant. Who am I speaking to?`;
}

/** Full store name for conversational retail opening — keeps Donegal Town etc. */
export function resolveConversationalRetailBusinessName(input: {
  name: string;
  greeting?: string | null;
  agentBaseTown?: string | null;
}): string {
  return resolveSpokenBusinessName({ ...input, preserveRetailLocation: true });
}
