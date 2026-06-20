/**
 * Canonical booking-link SMS consent phrases and auto-send detector.
 * Prompt embeds BOOKING_SMS_CONSENT_PHRASES verbatim — unit test locks detector sync.
 */
export const BOOKING_SMS_CONSENT_PHRASES = [
  "I can text you our booking link to the number you're calling from — is that alright?",
  "I'll text the booking link to the number you're on — is that alright?",
] as const;

const CONSENT_ASK =
  /\b(is that alright|is that okay|shall i send|okay to send|that okay)\b/i;

/** Booking-link SMS offer — excludes generic "text you directions" etc. */
function offersBookingLinkSmsConsent(text: string): boolean {
  if (/\bbooking link\b/i.test(text)) return true;
  if (/\btext the booking link\b/i.test(text)) return true;
  if (/\btext you\b.*\b(booking|link)\b/i.test(text)) return true;
  if (/\btext it\b.*\b(booking|link)\b/i.test(text)) return true;
  if (/\bshall i send\b/i.test(text) && /\b(booking|link)\b/i.test(text)) return true;
  return /\btext\b/i.test(text) && /\b(booking|link)\b/i.test(text) && CONSENT_ASK.test(text);
}

/** True when assistant speech should arm booking-link SMS auto-send. */
export function assistantOfferedBookingLinkConsent(text: string): boolean {
  if (!text.trim() || !CONSENT_ASK.test(text)) return false;
  return offersBookingLinkSmsConsent(text);
}

/** Bullet list for the live-call prompt (exact phrases Cara may use). */
export function formatBookingSmsConsentPhrasesForPrompt(): string {
  return BOOKING_SMS_CONSENT_PHRASES.map((p) => `- "${p}"`).join('\n');
}
