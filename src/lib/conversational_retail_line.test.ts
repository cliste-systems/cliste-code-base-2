import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRetailConversationalOpening,
  isConversationalRetailLine,
  resolveConversationalRetailBusinessName,
  RETAIL_LINE_OPENING_PAUSE_MS,
  shouldUseDemoExperienceStack,
} from './conversational_retail_line.js';

describe('conversational_retail_line', () => {
  it('detects the Kavanaghs retail demo number', () => {
    assert.equal(isConversationalRetailLine('+353749759508'), true);
    assert.equal(isConversationalRetailLine('353749759508'), true);
  });

  it('does not use demo experience stack for conversational retail alone', () => {
    assert.equal(
      shouldUseDemoExperienceStack({
        testCall: false,
        conversationalRetailLine: isConversationalRetailLine('+353749759508'),
      }),
      false,
    );
    assert.equal(
      shouldUseDemoExperienceStack({
        testCall: true,
        conversationalRetailLine: true,
      }),
      true,
    );
  });

  it('does not treat the Hello Cara demo line as conversational retail', () => {
    assert.equal(isConversationalRetailLine('+353749389378'), false);
  });

  it('builds a single Cara intro with disclosure and help question', () => {
    assert.equal(
      buildRetailConversationalOpening('Kavanaghs SuperValu Donegal Town'),
      "Hello, you're through to Kavanaghs SuperValu Donegal Town. I'm Cara, the AI assistant. This call may be recorded and transcribed. How can I help you today?",
    );
  });

  it('uses no artificial opening pause — cached PCM plays immediately', () => {
    assert.equal(RETAIL_LINE_OPENING_PAUSE_MS, 0);
  });

  it('keeps Donegal Town on conversational retail name resolution', () => {
    assert.equal(
      resolveConversationalRetailBusinessName({
        name: 'Kavanaghs SuperValu Donegal Town',
        greeting:
          "You're through to Kavanaghs SuperValu Donegal Town — I'm Cara, the AI assistant.",
      }),
      'Kavanaghs SuperValu Donegal Town',
    );
  });
});
