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

  it('requires one agenda item per turn without cramming opening beats', () => {
    const block = formatDemoConversationalBehaviourForPrompt();
    assert.match(block, /One agenda item per turn/i);
    assert.match(block, /Cramming thanks \+ recording \+ how-are-you/i);
  });

  it('requires reaction word before agenda item and forbids parroting examples', () => {
    const block = formatDemoConversationalBehaviourForPrompt();
    assert.match(block, /Open with a tiny reaction/i);
    assert.match(block, /Never parrot this prompt/i);
    assert.match(block, /Bare "How are you keeping\?" right after they say ok/i);
  });

  it('requires recording consent as a question and bans quality disclaimers', () => {
    const block = formatDemoConversationalBehaviourForPrompt();
    assert.match(block, /must end with a question/i);
    assert.match(block, /never.*we record calls for quality/i);
    assert.ok(DEMO_BANNED_AI_SLOP.includes('just a quick note'));
    assert.ok(DEMO_BANNED_AI_SLOP.includes('thanks for that'));
    assert.ok(DEMO_BANNED_AI_SLOP.includes('for quality'));
  });

  it('skips greeting mirror on plain name intro and describes Martin failure', () => {
    const block = formatDemoConversationalBehaviourForPrompt();
    assert.match(block, /Only mirror.*hello/i);
    assert.match(block, /skip greeting mirror/i);
    assert.match(block, /Forced \*hiya\*.*My name is Martin/i);
  });

  it('puts the LLM in charge of the opening arc', () => {
    const block = formatDemoPersonalityForPrompt();
    assert.match(block, /You own the opening arc/i);
    assert.doesNotMatch(block, /programmatic opening/i);
  });
});
