import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRetailConversationalOpening,
  isConversationalRetailLine,
  resolveConversationalRetailBusinessName,
} from './conversational_retail_line.js';

describe('conversational_retail_line', () => {
  it('detects the Kavanaghs retail demo number', () => {
    assert.equal(isConversationalRetailLine('+353749759508'), true);
    assert.equal(isConversationalRetailLine('353749759508'), true);
  });

  it('does not treat the Hello Cara demo line as conversational retail', () => {
    assert.equal(isConversationalRetailLine('+353749389378'), false);
  });

  it('builds a name-first store opening with Cara and AI disclosure', () => {
    assert.equal(
      buildRetailConversationalOpening('Kavanaghs SuperValu Donegal Town'),
      "Hello, you're through to Kavanaghs SuperValu Donegal Town. I'm Cara, the AI assistant. Can I get your name?",
    );
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
