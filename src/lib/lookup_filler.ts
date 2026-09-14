/** Brief spoken cues while slow lookup tools run — programmatic, not LLM-generated. */

export const LOOKUP_FILLER_PHRASES = [
  'Right — let me have a look for you.',
  'Grand — give me a second there.',
  'No bother — I\'ll check that now.',
  'Let me see what we have on that.',
  'Right so — I\'ll look that up for you.',
  'Happy days — just a sec while I check.',
] as const;

export function nextLookupFillerPhrase(playCount: number): string {
  const index = Math.max(0, playCount) % LOOKUP_FILLER_PHRASES.length;
  return LOOKUP_FILLER_PHRASES[index]!;
}

/** True when the assistant already said a lookup-style line this turn. */
export function looksLikeLookupFillerSpeech(text: string): boolean {
  return /\b(let me have a look|give me a (?:second|sec)|check that now|look that up|see what we have|just a sec while i check|i'll check|one sec|have a look for you)\b/i.test(
    text,
  );
}

export function resolveLookupFillerDelayMs(options: {
  conversationalRetailLine: boolean;
  demoExperienceStack: boolean;
}): number {
  const raw = process.env.LIVEKIT_RESPONSE_FILLER_MS?.trim();
  if (options.conversationalRetailLine) return 0;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  if (options.conversationalRetailLine) return 350;
  if (options.demoExperienceStack) return 1000;
  return 0;
}

export function resolveLookupFillerMaxPerCall(): number {
  const parsed = Number.parseInt(
    process.env.LIVEKIT_RESPONSE_FILLER_MAX_PER_CALL ?? '5',
    10,
  );
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 5;
}

/** Minimum gap between programmatic lookup lines on one call. */
export const LOOKUP_FILLER_COOLDOWN_MS = 2500;

/** Caller phrasing that will usually trigger searchSuperValuProducts — not hours/FAQ. */
export function callerUtteranceLikelyNeedsProductLookup(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  if (/\b(open|close|closing|hours|direction|where is the|where's the|parking|manager)\b/.test(t)) {
    return false;
  }
  if (
    /\b(do you sell|do you stock|do you carry|have you got|do you do any|do you have any|do you have\b.*\b(offer|brand|pack))\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(how much|what'?s the price|on offer|this week|on special|own brand|supervalu brand)\b/.test(t)) {
    return true;
  }
  return false;
}
