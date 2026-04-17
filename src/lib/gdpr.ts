/**
 * GDPR / data-minimisation helpers.
 *
 * Storage policy for this voice agent:
 *  - **Booking details** (name, mobile, service, time, booking reference) are
 *    necessary for the contract with the customer (GDPR Art 6(1)(b)) and are
 *    persisted in the salon's database.
 *  - **Call transcripts and AI summaries** are kept only to give the salon a
 *    record of the conversation; they MUST NOT contain payment-card data,
 *    CVV/security codes, IBANs, PPS numbers, or anything that looks like
 *    special-category data the agent had no business collecting.
 *  - **Logs to stdout** (Railway) are processed by a third party — caller
 *    phone numbers are masked at the info level so they cannot be lifted
 *    from log files.
 *
 * The redaction is deliberately conservative — it errs on the side of
 * dropping a potential card number even when the regex match might be a
 * false positive. The agent is instructed never to read card data on the
 * call (it should send a Stripe link instead), so any 13–19 digit run
 * captured by STT is almost certainly a card number that we don't want to
 * keep.
 */

/** Replacement token used for redacted spans — picked so it survives JSON encoding. */
const REDACTED = '[redacted]';

/**
 * Strip likely payment-card / sensitive identifiers from a verbatim transcript
 * or AI summary before persisting or sending to a third-party LLM.
 *
 * Patterns redacted:
 *  - 13–19 digit runs separated by spaces / dashes (Visa/MC/Amex/IBAN-ish)
 *  - 3–4 digit "security code" / CVV references with the digits beside them
 *  - Spoken card numbers ("four eight one two two two two two…") — any run
 *    of >= 8 number-words in a row
 *  - Irish PPS numbers (7 digits + 1–2 letters)
 *  - "expir(y|es)" or "exp" + a 2/4 digit number
 *
 * We deliberately KEEP names, phone numbers and email addresses untouched —
 * those are the legitimate purpose of the call (booking contact details).
 */
export function redactPii(input: string | null | undefined): string {
  if (!input) {
    return '';
  }
  let s = input;

  // 1. Long digit runs (likely card numbers / IBANs). Allow spaces, dashes, dots
  //    between digits. Min 13 digits — phones are usually 10–12 with a +.
  s = s.replace(
    /(?<![+\w])(?:\d[\s\-.]?){13,19}\d(?![\w])/g,
    REDACTED,
  );

  // 2. Explicit CVV / security code phrases followed by 3–4 digits.
  s = s.replace(
    /\b(?:cvv|cvc|security\s*code|card\s*code)\b[^\d\n]{0,12}\d{3,4}/gi,
    REDACTED,
  );

  // 3. Expiry phrases ("exp 12/27", "expires 1227", "expiry 12 27").
  s = s.replace(
    /\b(?:exp(?:iry|ires|\.)?|valid\s*thru)\b[^\d\n]{0,8}\d{2,4}\s*[\/\-\s]?\s*\d{0,4}/gi,
    REDACTED,
  );

  // 4. Spoken card numbers — long runs of digit-words. Catches "four eight one
  //    two two two two two two two two two two two two two".
  const numberWord =
    '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)';
  s = s.replace(
    new RegExp(`(?:${numberWord}\\s+){8,}${numberWord}`, 'gi'),
    REDACTED,
  );

  // 5. Irish PPS numbers — 7 digits + 1 letter (+ optional second letter).
  s = s.replace(/\b\d{7}[A-Za-z]{1,2}\b/g, REDACTED);

  // 6. IBAN-ish: 2 letters + 2 check digits + up to 30 alphanum (compact form).
  s = s.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, REDACTED);

  return s;
}

/**
 * Mask a phone number for stdout logging while keeping enough context for
 * support to identify the line. "+353871234567" → "+353 87 *** 7890".
 *
 * Returns the input verbatim only when it cannot be parsed (e.g. "unknown").
 */
export function maskPhone(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  if (!t) {
    return '';
  }
  if (t.toLowerCase() === 'unknown') {
    return 'unknown';
  }
  const digits = t.replace(/\D/g, '');
  if (digits.length < 6) {
    return REDACTED;
  }
  const last4 = digits.slice(-4);
  if (digits.startsWith('353') && digits.length >= 11) {
    const local = digits.slice(3);
    const prefix = local.slice(0, 2);
    return `+353 ${prefix} *** ${last4}`;
  }
  if (digits.startsWith('44') && digits.length >= 10) {
    const local = digits.slice(2);
    const prefix = local.slice(0, 2);
    return `+44 ${prefix} *** ${last4}`;
  }
  if (digits.startsWith('1') && digits.length === 11) {
    return `+1 *** *** ${last4}`;
  }
  if (t.startsWith('+')) {
    return `+${digits.slice(0, Math.max(2, digits.length - 7))} *** ${last4}`;
  }
  return `*** ${last4}`;
}

/** Convenience for objects logged at info level (e.g. {customerPhone, …}). */
export function withMaskedPhone<T extends Record<string, unknown>>(
  obj: T,
  keys: ReadonlyArray<keyof T> = ['customerPhone', 'callerPhone', 'phone', 'to', 'from'] as ReadonlyArray<keyof T>,
): T {
  const out: Record<string, unknown> = { ...obj };
  for (const k of keys) {
    const v = out[k as string];
    if (typeof v === 'string') {
      out[k as string] = maskPhone(v);
    }
  }
  return out as T;
}
