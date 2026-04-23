/**
 * Human time strings for voice agent tool outputs so the LLM does not misread ISO
 * (e.g. `T12:00:00Z` spoken as "midnight") and so TTS doesn't mangle `3:00 pm`
 * into "three hundred o'clock p m".
 *
 * We return two things in the same string:
 *   1. A calendar phrase ("Saturday the 18th of April")
 *   2. A TTS-safe clock phrase ("at 3 pm", "at half past 2", "at a quarter past 10")
 *
 * ElevenLabs/most TTS engines read "3:00 pm" literally as digits; spelling the
 * hour + am/pm out (and dropping the :00) gives natural speech.
 */
function ordinalSuffix(day: number): string {
  const n = day % 100;
  if (n >= 11 && n <= 13) return 'th';
  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

export function formatSlotTimeSpoken(iso: string, timeZone: string): string {
  const d = new Date(iso.trim());
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const tz = timeZone.trim() || 'Europe/Dublin';
  try {
    const parts = new Intl.DateTimeFormat('en-IE', {
      timeZone: tz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).formatToParts(d);
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const month = parts.find((p) => p.type === 'month')?.value ?? '';
    const dayNum = Number.parseInt(parts.find((p) => p.type === 'day')?.value ?? '0', 10);
    const datePart =
      weekday && month && dayNum > 0
        ? `${weekday} the ${dayNum}${ordinalSuffix(dayNum)} of ${month}`
        : new Intl.DateTimeFormat('en-IE', {
            timeZone: tz,
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          }).format(d);

    const hour24 = Number.parseInt(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
      }).format(d),
      10,
    );
    const minute = Number.parseInt(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        minute: 'numeric',
        hour12: false,
      }).format(d),
      10,
    );

    const clockPhrase = speechClockPhrase(hour24, minute);
    return `${datePart} ${clockPhrase}`;
  } catch {
    return iso;
  }
}

/**
 * Turn 24h hour+minute into natural spoken English.
 * Rules:
 *   - :00      → "at 3 pm"
 *   - :30      → "at half past 3"
 *   - :15/:45  → "at a quarter past 3" / "at a quarter to 4"
 *   - other    → "at 3:05 pm" written as "at 5 past 3" style for the common cases,
 *                 otherwise fall back to a clean "at 3 oh 5 pm" shape that TTS
 *                 tends to pronounce correctly.
 *   - 0h       → "at midnight"
 *   - 12h:00   → "at midday"
 */
function speechClockPhrase(hour24: number, minute: number): string {
  if (hour24 === 0 && minute === 0) return 'at midnight';
  if (hour24 === 12 && minute === 0) return 'at midday';

  const ampm = hour24 < 12 ? 'am' : 'pm';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const nextHour12 = ((hour24 + 1) % 12 === 0 ? 12 : (hour24 + 1) % 12);
  const nextAmPm = hour24 + 1 === 12 ? 'pm' : hour24 + 1 === 24 ? 'am' : ampm;

  if (minute === 0) return `at ${hour12} ${ampm}`;
  if (minute === 30) return `at half past ${hour12}`;
  if (minute === 15) return `at a quarter past ${hour12}`;
  if (minute === 45) return `at a quarter to ${nextHour12} ${nextAmPm}`;

  // Fallback: minutes past the hour, spelled so TTS doesn't say "three hundred".
  // e.g. "at 5 past 3 pm", "at 20 past 10 am".
  if (minute < 30) return `at ${minute} past ${hour12} ${ampm}`;
  const minutesTo = 60 - minute;
  return `at ${minutesTo} to ${nextHour12} ${nextAmPm}`;
}
