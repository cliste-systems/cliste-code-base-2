/**
 * Human time strings for voice agent tool outputs so the LLM does not misread ISO
 * (e.g. `T12:00:00Z` spoken as "midnight").
 */
export function formatSlotTimeSpoken(iso: string, timeZone: string): string {
  const d = new Date(iso.trim());
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const tz = timeZone.trim() || 'Europe/Dublin';
  try {
    const line = new Intl.DateTimeFormat('en-IE', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d);

    const hour24 = Number.parseInt(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
      }).format(d),
      10,
    );

    if (hour24 === 0) {
      return `${line} (midnight)`;
    }
    if (hour24 === 12) {
      return `${line} (midday—twelve noon, not midnight)`;
    }
    return line;
  } catch {
    return iso;
  }
}
