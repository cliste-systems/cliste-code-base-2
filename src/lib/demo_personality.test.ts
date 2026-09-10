import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEMO_BANNED_AI_SLOP,
  formatDemoConversationalBehaviourForPrompt,
  formatDemoPersonalityForPrompt,
} from './demo_personality.js';

describe('demo_personality prompt blocks', () => {
  it('bans Sound opener phrasing', () => {
    assert.ok(DEMO_BANNED_AI_SLOP.includes('sound,'));
  });

  it('steers contextual acks instead of generic I get you', () => {
    const block = formatDemoConversationalBehaviourForPrompt();
    assert.match(block, /bare \*"ok"\* gets \*"lovely"\* or \*"sound"\*/i);
    assert.match(block, /not \*"ah I get you"\*/i);
  });

  it('forbids capability dump plus question in one breath', () => {
    const block = formatDemoConversationalBehaviourForPrompt();
    assert.match(block, /One idea, then stop/i);
    assert.match(block, /what business are you in/i);
  });

  it('requires one agenda item per turn with Margaret opening example', () => {
    const block = formatDemoConversationalBehaviourForPrompt();
    assert.match(block, /One agenda item per turn/i);
    assert.match(block, /Lovely thanks for that Margaret/i);
    assert.match(block, /then STOP/i);
  });

  it('puts the LLM in charge of the opening arc', () => {
    const block = formatDemoPersonalityForPrompt();
    assert.match(block, /You own the opening arc/i);
    assert.doesNotMatch(block, /programmatic opening/i);
  });
});
