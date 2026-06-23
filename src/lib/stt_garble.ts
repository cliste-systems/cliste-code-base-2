/** Booking intent + common salon STT garble detection (live-call heuristics). */

const BOOKING_INTENT_RE = /\b(book|booking|appointment|schedule)\b/i;

export function soundsLikeCancelOrChangeAppointment(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\b(appointment|booking)\b/.test(t)) return false;
  return /\b(cancel|reschedule|rebook|change|move|break|postpone|swap|amend)\b/.test(t);
}

/** STT often mishears "haircut" as "for the quote" near booking words. */
function soundsLikeGarbledHaircutBooking(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\b(book|booking|appointment)\b/.test(t)) return false;
  return /\b(for the )?quote\b/.test(t);
}

export function detectLikelySttGarble(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\bR appointment\b/i.test(t)) return true;
  if (soundsLikeGarbledHaircutBooking(t)) return true;
  return false;
}

export function soundsLikeBookingIntent(text: string): boolean {
  if (soundsLikeCancelOrChangeAppointment(text)) return false;
  const t = text.toLowerCase();
  if (BOOKING_INTENT_RE.test(t)) return true;
  if (soundsLikeGarbledHaircutBooking(t)) return true;
  if (/\bR appointment\b/i.test(t)) return true;
  return (
    /\b(haircut|hair cut|blow dry|colour|color|wax|facial|manicure|pedicure)\b/.test(t) &&
    /\b(please|want|like|need|get|book)\b/.test(t)
  );
}
