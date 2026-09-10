import {
  formatBusinessHoursForPrompt,
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

  return [
    'Structured opening hours (authoritative — use these, not bank-holiday guesses):',
    todaySpoken,
    ...lines,
    'If they name a weekday, answer that weekday only. Bank/public holidays are separate — do not say closed on a normal weekday unless that weekday is marked closed above.',
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
  opts?: { correcting?: boolean },
): string | null {
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
