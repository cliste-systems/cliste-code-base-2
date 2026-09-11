import { inferDemoCallerFirstName } from './natural_phrasing.js';
import { callerSoundsLikeOpenHoursQuestion } from './retail_hours.js';
import { callerSoundsLikeRetailStaffQuestion } from './retail_staff_questions.js';
import { soundsLikeBookingIntent } from './stt_garble.js';
import {
  callerAskedNewQuestion,
  callerSoundsLikeAffirmativeConsent,
} from './speech_triggers.js';

export type RetailOpeningFlags = {
  retailCallerName?: string | null;
  retailRecordingNoticePlayed?: boolean;
  retailOpeningComplete?: boolean;
};

export function buildRetailRecordingNotice(callerName: string): string {
  const name = callerName.trim();
  return `Perfect, ${name} — just so you're aware, this call may be recorded, yeah?`;
}

export function buildRetailHelpPivot(callerName: string): string {
  const name = callerName.trim();
  return `Perfect, ${name}, what can I help you with today?`;
}

export function inferRetailCallerFirstName(text: string): string | null {
  return inferDemoCallerFirstName([text]);
}

/** Caller moved past recording ack into a store errand — skip the help pivot. */
export function retailOpeningLooksLikeStoreQuestion(text: string): boolean {
  const t = text.trim();
  if (!t || callerSoundsLikeAffirmativeConsent(text)) return false;
  if (callerSoundsLikeOpenHoursQuestion(text)) return true;
  if (callerSoundsLikeRetailStaffQuestion(text)) return true;
  if (callerAskedNewQuestion(text)) return true;
  if (soundsLikeBookingIntent(text)) return true;
  return t.length > 24 && /\?/.test(t);
}

export type RetailOpeningTurn =
  | { kind: 'none' }
  | { kind: 'recording_notice'; callerName: string; line: string }
  | { kind: 'help_pivot'; callerName: string; line: string }
  | { kind: 'defer_to_llm' };

export function resolveRetailOpeningTurn(
  text: string,
  flags: RetailOpeningFlags,
): RetailOpeningTurn {
  if (flags.retailOpeningComplete) return { kind: 'none' };

  if (!flags.retailCallerName) {
    const callerName = inferRetailCallerFirstName(text);
    if (!callerName) return { kind: 'none' };
    return {
      kind: 'recording_notice',
      callerName,
      line: buildRetailRecordingNotice(callerName),
    };
  }

  if (!flags.retailRecordingNoticePlayed) return { kind: 'none' };

  if (retailOpeningLooksLikeStoreQuestion(text)) {
    return { kind: 'defer_to_llm' };
  }

  if (callerSoundsLikeAffirmativeConsent(text)) {
    return {
      kind: 'help_pivot',
      callerName: flags.retailCallerName,
      line: buildRetailHelpPivot(flags.retailCallerName),
    };
  }

  return { kind: 'none' };
}
