/** Retail STT garble detection (live-call heuristics). */

/** STT often mishears "cake" as "order of cake" or similar fragments. */
function soundsLikeGarbledCakeOrder(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\b(order|cake)\b/.test(t)) return false;
  return /\border of cake\b/.test(t) || /\bcake order\b/.test(t);
}

export function detectLikelySttGarble(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (soundsLikeGarbledCakeOrder(t)) return true;
  return false;
}

/**
 * Non-linguistic STT fragments only — never treat hello/hi/ok as phantom; callers must always get a reply.
 */
export function isPhantomCallerTranscript(text: string): boolean {
  const raw = text.trim();
  if (!raw) return true;
  if (raw.length <= 1) return true;
  const t = raw
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return true;
  if (/^(um|uh|eh|ah|er|hmm|mm)$/.test(t)) return true;
  return false;
}

export function soundsLikeSubstantiveServiceAnswer(text: string): boolean {
  const t = text.trim();
  if (isPhantomCallerTranscript(t)) return false;
  if (detectLikelySttGarble(t)) return false;
  if (t.length < 5) return false;
  return /\b(cake|bakery|stock|price|complaint|manager|deli|butcher|department|hours|open|closed)\b/i.test(
    t,
  );
}
