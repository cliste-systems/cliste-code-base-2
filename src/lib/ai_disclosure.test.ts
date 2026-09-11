import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveAiDisclosure } from './ai_disclosure.js';

describe('resolveAiDisclosure', () => {
  it('skips when greeting already includes AI disclosure', () => {
    const result = resolveAiDisclosure({
      greetingText:
        "You're through to Murphy's SuperValu — I'm Cara, the AI assistant. This call may be recorded and transcribed.",
      niche: 'retail',
    });
    assert.equal(result.disabled, true);
    assert.equal(result.source, 'greeting-includes');
    assert.equal(result.text, '');
  });

  it('skips disclosure on Hello Cara demo line', () => {
    const result = resolveAiDisclosure({
      greetingText: "Hey there, you're through to Cara — can I get your name please?",
      demoLine: true,
    });
    assert.equal(result.disabled, true);
    assert.equal(result.text, '');
  });

  it('skips disclosure on conversational retail opening', () => {
    const result = resolveAiDisclosure({
      greetingText:
        "Hello, you're through to Kavanaghs SuperValu Donegal Town. I'm Cara, the AI assistant. Can I get your name?",
      niche: 'retail',
      conversationalOpening: true,
    });
    assert.equal(result.disabled, true);
    assert.equal(result.text, '');
  });

  it('never uses salon or booking disclosure copy', () => {
    const prev = process.env.CLISTE_AI_DISCLOSURE_OPENING;
    process.env.CLISTE_AI_DISCLOSURE_OPENING = 'on';
    try {
      const result = resolveAiDisclosure({ greetingText: 'Hello, how can I help?' });
      assert.equal(result.disabled, false);
      assert.match(result.text, /store/i);
      assert.doesNotMatch(result.text, /salon/i);
      assert.doesNotMatch(result.text, /booking/i);
    } finally {
      if (prev === undefined) delete process.env.CLISTE_AI_DISCLOSURE_OPENING;
      else process.env.CLISTE_AI_DISCLOSURE_OPENING = prev;
    }
  });
});
