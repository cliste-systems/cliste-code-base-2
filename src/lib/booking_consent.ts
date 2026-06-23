import { callerAskedPhoneOrHumanBooking } from './speech_triggers.js';

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

/** Bullet list for the live-call prompt (must match assistantOfferedBookingLinkConsent). */
export function formatBookingSmsConsentPhrasesForPrompt(): string {
  return BOOKING_SMS_CONSENT_PHRASES.map((p) => `- "${p}"`).join('\n');
}

function normalizeCallerTurn(text: string): string {
  return text.trim().toLowerCase().replace(/[!?.]+/g, '').replace(/\s+/g, ' ');
}

/** Caller clearly declined the booking-link SMS offer. */
export function callerDeclinedSmsConsent(text: string): boolean {
  const t = normalizeCallerTurn(text);
  if (!t) return false;
  if (/^(yes|yeah|yep|sure|ok|okay|go ahead)\b/.test(t) && !/^no\b/.test(t)) {
    return false;
  }
  return (
    /^no\b/.test(t) ||
    /\b(nope|nah|not possible|can'?t|cannot|don'?t want|don'?t text|no thanks|rather not|won'?t|not really|don'?t send|stop texting)\b/.test(
      t,
    )
  );
}

const BOOKING_REQUEST_WORD =
  /\b(book|booking|appointment|schedule|lashes|lash|hair|haircut|nails|manicure|pedicure|colour|color|root|wax|facial|stylist|emma|with)\b/;

/**
 * Explicit SMS yes only — politeness "please" / casual "grand" on a booking request is NOT consent.
 */
export function callerGrantedSmsConsent(text: string): boolean {
  const t = normalizeCallerTurn(text);
  if (!t || callerDeclinedSmsConsent(text)) return false;
  if (callerAskedPhoneOrHumanBooking(text)) return false;

  if (/\b(maybe|not sure|perhaps)\b/.test(t) && !/\b(send (me )?the link|text me the link)\b/.test(t)) {
    return false;
  }

  if (BOOKING_REQUEST_WORD.test(t) && !/^(yes|yeah|yep|sure|ok|okay)\b/.test(t)) {
    return false;
  }

  if (
    t.length <= 36 &&
    /^(yes|yeah|yep|yup|sure|ok|okay|absolutely|definitely|go ahead|please do|do it|send it|text it|that'?s fine|sounds good|perfect|that works)(\s|$|[,.])/i.test(
      t,
    )
  ) {
    return true;
  }

  if (
    /\b(yes please|yeah please|yes that'?s fine|go ahead please|send (me )?the link|text me the link|you can text|that'?d be grand)\b/.test(
      t,
    )
  ) {
    return true;
  }

  return false;
}
