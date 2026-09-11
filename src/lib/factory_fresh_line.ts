import { normalizePhoneE164 } from './phone_normalize.js';

/** Spare Irish Twilio line — vanilla LiveKit Cartesia Siobhan, no demo orchestrator. */
const DEFAULT_FACTORY_FRESH_NUMBERS: string[] = [];

function factoryFreshNumberSet(): Set<string> {
  const fromEnv = (process.env.CARA_FACTORY_FRESH_CALLED_NUMBERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set<string>();
  for (const raw of [...DEFAULT_FACTORY_FRESH_NUMBERS, ...fromEnv]) {
    set.add(raw.trim());
    const normalized = normalizePhoneE164(raw);
    if (normalized) set.add(normalized);
  }
  return set;
}

/** Baseline Siobhan test line — compare against the full Hello Cara demo stack. */
export function isFactoryFreshLine(calledNumber: string | null | undefined): boolean {
  const t = calledNumber?.trim();
  if (!t) return false;
  const set = factoryFreshNumberSet();
  if (set.has(t)) return true;
  const normalized = normalizePhoneE164(t);
  return normalized ? set.has(normalized) : false;
}

export function primaryFactoryFreshCalledNumber(): string {
  const fromEnv = (process.env.CARA_FACTORY_FRESH_CALLED_NUMBERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return fromEnv ?? '';
}
