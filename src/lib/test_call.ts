import { normalizePhoneE164 } from './phone_normalize.js';

const DEFAULT_TEST_CALLED_NUMBERS = ['+353749389378'];

function testCalledNumberSet(): Set<string> {
  const fromEnv = (process.env.CARA_TEST_CALLED_NUMBERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const variants = new Set<string>();
  for (const raw of [...DEFAULT_TEST_CALLED_NUMBERS, ...fromEnv]) {
    const normalized = normalizePhoneE164(raw);
    if (normalized) variants.add(normalized);
    variants.add(raw.trim());
  }
  return variants;
}

/** True when the inbound DID is an internal QA / split-test line. */
export function isTestCall(calledNumber: string | null | undefined): boolean {
  const t = calledNumber?.trim();
  if (!t) return false;
  const set = testCalledNumberSet();
  if (set.has(t)) return true;
  const normalized = normalizePhoneE164(t);
  return normalized ? set.has(normalized) : false;
}

export function primaryTestCalledNumber(): string {
  return DEFAULT_TEST_CALLED_NUMBERS[0]!;
}
