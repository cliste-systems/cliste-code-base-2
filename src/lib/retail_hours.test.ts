import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRetailHoursSpokenReply,
  callerSoundsLikeOpenHoursQuestion,
  callerSoundsLikeWeekdayHoursCorrection,
  formatStructuredHoursForLivePrompt,
  hoursLineForWeekday,
  hoursQuestionDay,
  weekdayMentionedInText,
} from './retail_hours.js';

const hours = {
  monday: { open: true, start: '08:00', end: '21:00' },
  thursday: { open: true, start: '08:00', end: '21:00' },
  sunday: { open: true, start: '09:00', end: '18:00' },
};

describe('retail_hours', () => {
  it('formats structured hours for prompt', () => {
    const block = formatStructuredHoursForLivePrompt(hours, 'Europe/Dublin', 'Thursday 5 June 2026');
    assert.match(block ?? '', /Structured opening hours/i);
    assert.match(block ?? '', /thursday:/i);
  });

  it('detects weekday correction', () => {
    assert.equal(callerSoundsLikeWeekdayHoursCorrection("He's open on Thursday."), true);
    assert.equal(callerSoundsLikeWeekdayHoursCorrection('Are you open on Thursday?'), false);
  });

  it('resolves weekday from text', () => {
    assert.equal(weekdayMentionedInText('open on Thursday'), 'thursday');
  });

  it('returns hours line for weekday', () => {
    const line = hoursLineForWeekday(hours, 'thursday');
    assert.match(line ?? '', /thursday:/i);
  });

  it('detects open-hours questions including talking-tomorrow garble', () => {
    assert.equal(callerSoundsLikeOpenHoursQuestion('Are you talking tomorrow?'), true);
    assert.equal(callerSoundsLikeOpenHoursQuestion('Are you open tomorrow?'), true);
    assert.equal(callerSoundsLikeOpenHoursQuestion("He's open tomorrow."), true);
    assert.equal(callerSoundsLikeOpenHoursQuestion('How are you keeping?'), false);
  });

  it('builds spoken retail hours without LLM', () => {
    const line = buildRetailHoursSpokenReply(
      hours,
      "Very good. Yeah. He's open tomorrow.",
      'Europe/Dublin',
    );
    assert.match(line ?? '', /Tomorrow we're open from/i);
    assert.match(line ?? '', /nine in the morning/i);
    assert.match(line ?? '', /six in the evening/i);
  });

  it('builds correction phrasing for weekday hours', () => {
    const line = buildRetailHoursSpokenReply(hours, "He's open on Thursday.", 'Europe/Dublin', {
      correcting: true,
    });
    assert.match(line ?? '', /Sorry about that/i);
    assert.match(line ?? '', /Thursday/i);
  });

  it('resolves tomorrow for hours questions', () => {
    const day = hoursQuestionDay('Are you open tomorrow?', 'Europe/Dublin');
    assert.ok(day);
  });
});
