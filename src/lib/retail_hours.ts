import {
  formatBusinessHoursForPrompt,
  parseBankHolidayConfig,
  parseBusinessHoursSchedule,
  weekdayKeyFromDate,
  type DaySchedule,
} from './business_hours.js';
import { callerSoundsLikeSocialChitchat } from './speech_triggers.js';

const WEEKDAY_NAMES = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const HOUR_WORDS = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
] as const;

function fmtSpokenMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) {
    if (h === 12) return 'twelve noon';
    if (h === 0) return 'midnight';
    return h <= 12 ? `${h} o'clock` : `${h - 12} o'clock`;
  }
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** Natural Irish phone phrasing for TTS — "nine in the morning", "six in the evening". */
function spokenTimeForPhone(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m !== 0) return fmtSpokenMinutes(mins);
  if (h === 0) return 'midnight';
  if (h === 12) return 'twelve noon';
  if (h < 12) return `${HOUR_WORDS[h] ?? h} in the morning`;
  const pm = h - 12;
  return `${HOUR_WORDS[pm] ?? pm} in the evening`;
}

function spokenOpenCloseForPhone(row: DaySchedule): { open: string; close: string } {
  if (row === 'closed') {
    return { open: 'closed', close: 'closed' };
  }
  return {
    open: spokenTimeForPhone(row.openMin),
    close: spokenTimeForPhone(row.closeMin),
  };
}

function spokenDayHours(row: DaySchedule): string {
  if (row === 'closed') return 'closed';
  return `${fmtSpokenMinutes(row.openMin)} to ${fmtSpokenMinutes(row.closeMin)}`;
}

/** YYYY-MM-DD in org timezone — for public-holiday checks. */
function localDateKey(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Irish public holidays — extend as needed for live-call date checks. */
const IRISH_PUBLIC_HOLIDAY_KEYS = new Set<string>([
  '2025-01-01',
  '2025-02-03',
  '2025-03-17',
  '2025-04-21',
  '2025-05-05',
  '2025-06-02',
  '2025-08-04',
  '2025-10-27',
  '2025-12-25',
  '2025-12-26',
  '2026-01-01',
  '2026-02-02',
  '2026-03-17',
  '2026-04-06',
  '2026-05-04',
  '2026-06-01',
  '2026-08-03',
  '2026-10-26',
  '2026-12-25',
  '2026-12-26',
  '2027-01-01',
  '2027-02-01',
  '2027-03-17',
  '2027-03-29',
  '2027-05-03',
  '2027-06-07',
  '2027-08-02',
  '2027-10-25',
  '2027-12-25',
  '2027-12-26',
]);

function isIrishPublicHoliday(d: Date, timeZone: string): boolean {
  return IRISH_PUBLIC_HOLIDAY_KEYS.has(localDateKey(d, timeZone));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function dateForWeekdayFromNow(
  day: (typeof WEEKDAY_NAMES)[number],
  timeZone: string,
  ref = new Date(),
): Date {
  const targetIndex = WEEKDAY_NAMES.indexOf(day);
  const currentKey = weekdayKeyFromDate(ref, timeZone);
  if (!currentKey) return ref;
  const currentIndex = WEEKDAY_NAMES.indexOf(currentKey);
  let delta = targetIndex - currentIndex;
  if (delta < 0) delta += 7;
  return addDays(ref, delta);
}

/** Resolve the calendar day the caller is asking about for hours (today / tomorrow / named weekday). */
export function hoursQuestionDate(text: string, timeZone: string, ref = new Date()): Date | null {
  const lower = text.toLowerCase();
  if (/\btomorrow\b/.test(lower)) return addDays(ref, 1);
  if (/\btoday\b/.test(lower)) return ref;
  const named = weekdayMentionedInText(text);
  if (named) return dateForWeekdayFromNow(named, timeZone, ref);
  return null;
}

export function callerSoundsLikeBankHolidayQuestion(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  return (
    /\b(st patrick|saint patrick|paddy'?s day|paddys day|bank holiday|public holiday|good friday|easter monday|christmas day|st stephen|boxing day|new year'?s day)\b/.test(
      t,
    ) || /\bopen on (the )?(holiday|bank)\b/.test(t)
  );
}

function buildBankHolidaySpokenReply(
  config: NonNullable<ReturnType<typeof parseBankHolidayConfig>>,
  text: string,
): string {
  const lower = text.toLowerCase();
  const namedStPatricks = /\b(st patrick|saint patrick|paddy'?s day|paddys day)\b/.test(lower);
  if (!config.open) {
    if (namedStPatricks) {
      return "We're closed on St Patrick's Day — we're closed on all bank and public holidays.";
    }
    return "We're closed on bank and public holidays.";
  }
  const open = config.startMin != null ? spokenTimeForPhone(config.startMin) : 'our usual hours';
  const close = config.endMin != null ? spokenTimeForPhone(config.endMin) : 'closing';
  if (namedStPatricks) {
    return `On St Patrick's Day we're open from ${open} till ${close}.`;
  }
  return `On bank and public holidays we're open from ${open} till ${close}.`;
}

function bankHolidayBlocksHoursAnswer(
  raw: unknown,
  text: string,
  timeZone: string,
  ref = new Date(),
): string | null {
  const config = parseBankHolidayConfig(raw);
  if (!config?.configured) return null;
  if (callerSoundsLikeBankHolidayQuestion(text)) {
    return buildBankHolidaySpokenReply(config, text);
  }
  const targetDate = hoursQuestionDate(text, timeZone, ref);
  if (targetDate && !config.open && isIrishPublicHoliday(targetDate, timeZone)) {
    if (/\btomorrow\b/.test(text.toLowerCase())) {
      return "Tomorrow we're closed — it's a bank and public holiday.";
    }
    if (/\btoday\b/.test(text.toLowerCase())) {
      return "Today we're closed — it's a bank and public holiday.";
    }
    const named = weekdayMentionedInText(text);
    if (named) {
      const label = named.charAt(0).toUpperCase() + named.slice(1);
      return `On ${label} we're closed — it's a bank and public holiday.`;
    }
  }
  return null;
}

/** Compact structured hours block for the live-call prompt wrapper. */
export function formatStructuredHoursForLivePrompt(
  raw: unknown,
  timeZone: string,
  todayLocal: string,
): string | null {
  const sched = parseBusinessHoursSchedule(raw);
  if (!sched) return null;

  const lines: string[] = [];
  for (const day of WEEKDAY_NAMES) {
    const row = sched.get(day);
    if (!row) continue;
    lines.push(`- ${day}: ${spokenDayHours(row)}`);
  }
  if (lines.length === 0) return null;

  const todayDay = weekdayKeyFromDate(new Date(), timeZone);
  const todayRow = todayDay ? sched.get(todayDay) : undefined;
  const todaySpoken =
    todayDay && todayRow
      ? `Today (${todayLocal}) — ${todayDay}: ${spokenDayHours(todayRow)}.`
      : `Today: ${todayLocal}.`;

  const bankConfig = parseBankHolidayConfig(raw);
  const bankLine = bankConfig?.configured
    ? bankConfig.open
      ? '- Bank & public holidays: special hours apply (see dashboard).'
      : '- Bank & public holidays: closed (including St Patrick\'s Day).'
    : null;

  return [
    'Structured opening hours (authoritative — use these, not bank-holiday guesses):',
    todaySpoken,
    ...lines,
    ...(bankLine ? [bankLine] : []),
    'If they name a weekday, answer that weekday only unless it falls on a bank/public holiday — then say closed.',
    'St Patrick\'s Day and other Irish public holidays: use the bank-holiday line above, not normal weekday hours.',
  ].join('\n');
}

export { formatBusinessHoursForPrompt };

/** Caller correcting hours, e.g. "we're open on Thursday". */
export function callerSoundsLikeWeekdayHoursCorrection(text: string): boolean {
  if (/\?/.test(text)) return false;
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (/^(are you|do you|what time|when are you|when do you)\b/.test(t)) return false;
  const hasWeekday = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/.test(
    t,
  );
  if (!hasWeekday) return false;
  return (
    /\b(open|opened|opening|we are open|you are open|you're open|not closed|is open)\b/.test(t) ||
    /\b(you said|that's wrong|that is wrong|actually|no we)\b/.test(t)
  );
}

export function weekdayMentionedInText(text: string): (typeof WEEKDAY_NAMES)[number] | null {
  const t = text.toLowerCase();
  const map: Record<string, (typeof WEEKDAY_NAMES)[number]> = {
    monday: 'monday',
    mon: 'monday',
    tuesday: 'tuesday',
    tue: 'tuesday',
    wednesday: 'wednesday',
    wed: 'wednesday',
    thursday: 'thursday',
    thu: 'thursday',
    thurs: 'thursday',
    friday: 'friday',
    fri: 'friday',
    saturday: 'saturday',
    sat: 'saturday',
    sunday: 'sunday',
    sun: 'sunday',
  };
  for (const [key, day] of Object.entries(map)) {
    if (new RegExp(`\\b${key}\\b`).test(t)) return day;
  }
  return null;
}

export function hoursLineForWeekday(raw: unknown, day: (typeof WEEKDAY_NAMES)[number]): string | null {
  const sched = parseBusinessHoursSchedule(raw);
  if (!sched) return null;
  const row = sched.get(day);
  if (!row) return null;
  return `${day}: ${spokenDayHours(row)}`;
}

/** Tomorrow's weekday in the org timezone. */
export function tomorrowWeekdayKey(timeZone: string): (typeof WEEKDAY_NAMES)[number] | null {
  const d = new Date(Date.now() + 86_400_000);
  return weekdayKeyFromDate(d, timeZone);
}

/** Opening-hours question — includes common STT garble ("talking tomorrow" → open tomorrow). */
export function callerSoundsLikeOpenHoursQuestion(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (callerSoundsLikeSocialChitchat(text)) return false;
  const dayHint =
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/.test(
      t,
    );
  if (/\b(are you|you|ye)\s+(open|opening|talking|taking)\s+tomorrow\b/.test(t)) return true;
  if (/\b(he'?s|she'?s|they'?re)\s+open\s+tomorrow\b/.test(t)) return true;
  if (/\bopen\s+tomorrow\b/.test(t)) return true;
  if (/\b(what time|when)\s+(do you|are you)\s+open\b/.test(t)) return true;
  if (/\b(are you|you)\s+open\b/.test(t) && dayHint) return true;
  if (/\b(opening|closing|close|hours)\b/.test(t) && dayHint) return true;
  return false;
}

/** Resolve which day the caller is asking about for hours. */
export function hoursQuestionDay(
  text: string,
  timeZone: string,
): (typeof WEEKDAY_NAMES)[number] | null {
  const named = weekdayMentionedInText(text);
  if (named) return named;
  if (/\btomorrow\b/.test(text.toLowerCase())) {
    return tomorrowWeekdayKey(timeZone);
  }
  if (/\btoday\b/.test(text.toLowerCase())) {
    return weekdayKeyFromDate(new Date(), timeZone);
  }
  return null;
}

/** Direct spoken hours answer — bypasses LLM for retail opening-hours questions. */
export function buildRetailHoursSpokenReply(
  raw: unknown,
  text: string,
  timeZone: string,
  opts?: { correcting?: boolean; ref?: Date },
): string | null {
  const bankReply = bankHolidayBlocksHoursAnswer(raw, text, timeZone, opts?.ref);
  if (bankReply) {
    if (opts?.correcting) {
      return `Sorry about that — ${bankReply.charAt(0).toLowerCase()}${bankReply.slice(1)}`;
    }
    return bankReply;
  }

  const sched = parseBusinessHoursSchedule(raw);
  if (!sched) return null;

  const day = hoursQuestionDay(text, timeZone) ?? weekdayMentionedInText(text);
  if (!day) return null;

  const row = sched.get(day);
  if (!row) return null;

  const lower = text.toLowerCase();
  const tomorrowAsk = /\btomorrow\b/.test(lower);
  const todayAsk = /\btoday\b/.test(lower);

  let answer: string;
  if (row === 'closed') {
    if (tomorrowAsk) answer = "We're closed tomorrow.";
    else if (todayAsk) answer = "We're closed today.";
    else {
      const label = day.charAt(0).toUpperCase() + day.slice(1);
      answer = `We're closed on ${label}.`;
    }
  } else {
    const { open, close } = spokenOpenCloseForPhone(row);
    if (tomorrowAsk) {
      answer = `Tomorrow we're open from ${open} till ${close}.`;
    } else if (todayAsk) {
      answer = `Today we're open from ${open} till ${close}.`;
    } else {
      const label = day.charAt(0).toUpperCase() + day.slice(1);
      answer = `On ${label} we're open from ${open} till ${close}.`;
    }
  }

  if (opts?.correcting) {
    return `Sorry about that — ${answer.charAt(0).toLowerCase()}${answer.slice(1)}`;
  }
  return answer;
}
