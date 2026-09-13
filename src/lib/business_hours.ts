/** Parse dashboard `organizations.business_hours` JSON for retail opening hours. */

const WEEK_ORDER = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const DAY_ALIASES: Record<string, (typeof WEEK_ORDER)[number]> = {
  monday: 'monday',
  mon: 'monday',
  mo: 'monday',
  tuesday: 'tuesday',
  tue: 'tuesday',
  tues: 'tuesday',
  wednesday: 'wednesday',
  wed: 'wednesday',
  thursday: 'thursday',
  thu: 'thursday',
  thur: 'thursday',
  thurs: 'thursday',
  friday: 'friday',
  fri: 'friday',
  saturday: 'saturday',
  sat: 'saturday',
  sunday: 'sunday',
  sun: 'sunday',
};

export type DaySchedule = { openMin: number; closeMin: number } | 'closed';

function parseHmToMinutes(s: unknown): number | null {
  if (typeof s !== 'string') {
    return null;
  }
  const t = s.trim().toLowerCase();
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    return null;
  }
  const hh = Number.parseInt(m[1]!, 10);
  const mm = Number.parseInt(m[2]!, 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  return hh * 60 + mm;
}

function fmtMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function normalizeDayKey(key: string): (typeof WEEK_ORDER)[number] | null {
  const k = key.trim().toLowerCase().replace(/\./g, '');
  return DAY_ALIASES[k] ?? null;
}

function parseOpenCloseValue(v: unknown): DaySchedule | null {
  if (v == null) {
    return 'closed';
  }
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === '' || t === 'closed' || t === 'none') {
      return 'closed';
    }
    const range = t.split(/\s*[-–—]\s*/);
    if (range.length === 2) {
      const a = parseHmToMinutes(range[0]!.trim());
      const b = parseHmToMinutes(range[1]!.trim());
      if (a != null && b != null && b > a) {
        return { openMin: a, closeMin: b };
      }
    }
    return null;
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o.closed === true || o.isClosed === true || o.open === false) {
      return 'closed';
    }
    const open = parseHmToMinutes(o.start ?? o.opens ?? o.from ?? o.open);
    const close = parseHmToMinutes(o.end ?? o.closes ?? o.to ?? o.close);
    if (open != null && close != null && close > open) {
      return { openMin: open, closeMin: close };
    }
  }
  return null;
}

/**
 * Returns a map day -> schedule for keys we could parse, or null if nothing usable.
 */
export function parseBusinessHoursSchedule(raw: unknown): Map<string, DaySchedule> | null {
  if (raw == null) {
    return null;
  }
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) {
      return null;
    }
    try {
      obj = JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null) {
    return null;
  }
  const rec = obj as Record<string, unknown>;
  const inner = (rec.hours ??
    rec.schedule ??
    rec.openingHours ??
    rec.opening_hours ??
    rec.weekly ??
    rec) as Record<string, unknown>;
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
    return null;
  }

  const out = new Map<string, DaySchedule>();

  if (Array.isArray(rec.days)) {
    for (const row of rec.days) {
      if (typeof row !== 'object' || row === null) {
        continue;
      }
      const r = row as Record<string, unknown>;
      const dayRaw = r.day ?? r.weekday ?? r.name;
      if (typeof dayRaw !== 'string') {
        continue;
      }
      const day = normalizeDayKey(dayRaw);
      if (!day) {
        continue;
      }
      const sched = parseOpenCloseValue(r);
      if (sched) {
        out.set(day, sched);
      }
    }
  }

  for (const [key, val] of Object.entries(inner)) {
    const day = normalizeDayKey(key);
    if (!day) {
      continue;
    }
    const sched = parseOpenCloseValue(val);
    if (sched) {
      out.set(day, sched);
    }
  }

  return out.size > 0 ? out : null;
}

export type BankHolidayConfig = {
  configured: boolean;
  open: boolean;
  startMin: number | null;
  endMin: number | null;
};

/** Parse dashboard bank-holiday flags from `organizations.business_hours` JSON. */
export function parseBankHolidayConfig(raw: unknown): BankHolidayConfig | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    try {
      obj = JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (rec._bankHolidaysConfigured !== true) return null;
  const open = rec._bankHolidaysOpen === true;
  const startMin = parseHmToMinutes(rec._bankHolidaysStart);
  const endMin = parseHmToMinutes(rec._bankHolidaysEnd);
  return {
    configured: true,
    open,
    startMin,
    endMin,
  };
}

/** Resolve weekday for `timeZone`, or `null` if the locale string is unexpected (skip strict hour checks). */
export function weekdayKeyFromDate(d: Date, timeZone: string): (typeof WEEK_ORDER)[number] | null {
  const wd = d
    .toLocaleDateString('en-US', { timeZone, weekday: 'long' })
    .trim()
    .toLowerCase();
  return DAY_ALIASES[wd] ?? null;
}

export function minutesSinceMidnightInTimezone(d: Date, timeZone: string): number {
  const s = d.toLocaleTimeString('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = s.split(':');
  const h = Number.parseInt(parts[0] ?? '', 10);
  const m = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    return 0;
  }
  return h * 60 + m;
}

