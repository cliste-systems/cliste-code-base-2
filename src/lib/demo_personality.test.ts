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

  it('puts the LLM in charge of the opening arc', () => {
    const block = formatDemoPersonalityForPrompt();
    assert.match(block, /You own the opening arc/i);
    assert.doesNotMatch(block, /programmatic opening/i);
  });
});
