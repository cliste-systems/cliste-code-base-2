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

/** Noise / partial STT that must not advance booking or bump reply turns. */
export function isPhantomCallerTranscript(text: string): boolean {
  const raw = text.trim();
  if (!raw) return true;
  if (raw.length <= 2) return true;
  if (/^[\d.]+$/.test(raw)) return true;
  const t = raw
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return true;
  if (/^(um|uh|eh|ah|er|hmm|mm|yeah|yes|no|ok|okay|sir|hello|hi)$/.test(t)) return true;
  if (/^(yes )?sir$/.test(t)) return true;
  return false;
}

export function soundsLikeSubstantiveServiceAnswer(text: string): boolean {
  const t = text.trim();
  if (isPhantomCallerTranscript(t)) return false;
  if (detectLikelySttGarble(t)) return false;
  if (t.length < 5) return false;
  return /\b(hair|nail|lash|lashes|brow|wax|facial|manicure|pedicure|colour|color|balayage|highlights?|touch[- ]?up|root|roots|cut|blow dry|treatment|massage|gel|acrylic|extension|tint|lamination|perm|blowdry|blow-dry)\b/i.test(
    t,
  );
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
