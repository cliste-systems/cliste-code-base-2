import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stripToolLinesFromTranscript } from './transcript_display.js';

describe('stripToolLinesFromTranscript', () => {
  it('removes tool request and result blocks', () => {
    const input = [
      'Assistant: Right so — we have a few different types.',
      '[Tool] searchSuperValuProducts {"intent":"price","query":"avocados"}',
      '[Tool result] {"ok":true,"message":"Several types or brands match"}',
      'Caller: Is there any of them on offer?',
      '[Tool] searchSuperValuProducts {"intent":"offer","query":"avocados"}',
      '[Tool result] {"ok":true,"message":"Use only these synced offer quotes"}',
      'Assistant: The Signature Tastes avocado is on offer at fifty nine cents.',
    ].join('\n\n');

    assert.equal(
      stripToolLinesFromTranscript(input),
      [
        'Assistant: Right so — we have a few different types.',
        'Caller: Is there any of them on offer?',
        'Assistant: The Signature Tastes avocado is on offer at fifty nine cents.',
      ].join('\n\n'),
    );
  });

  it('removes tool error blocks', () => {
    const input = [
      'Assistant: One moment.',
      '[Tool error] {"ok":false,"error":"timeout"}',
      'Caller: Hello?',
    ].join('\n\n');

    assert.equal(
      stripToolLinesFromTranscript(input),
      ['Assistant: One moment.', 'Caller: Hello?'].join('\n\n'),
    );
  });
});
