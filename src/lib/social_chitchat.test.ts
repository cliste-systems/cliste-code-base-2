import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatSocialChitchatForPrompt } from './social_chitchat.js';

describe('formatSocialChitchatForPrompt', () => {
  it('includes anti-loop and paraphrase rules for production', () => {
    const block = formatSocialChitchatForPrompt({
      mode: 'production',
      openingAlreadyAskedHelp: true,
      allowProactiveWellbeingQuestion: false,
    });

    assert.match(block, /paraphrase/i);
    assert.match(block, /Anti-loop/i);
    assert.match(block, /Help already asked/i);
    assert.match(block, /Do not.*open with.*how are you keeping/i);
  });

  it('allows proactive wellbeing question on demo', () => {
    const block = formatSocialChitchatForPrompt({
      mode: 'demo',
      allowProactiveWellbeingQuestion: true,
    });

    assert.match(block, /Demo opening arc/i);
    assert.match(block, /how are you keeping/i);
  });

  it('forbids errand openers on wellbeing turns', () => {
    const block = formatSocialChitchatForPrompt({
      mode: 'retail',
      openingAlreadyAskedHelp: true,
    });

    assert.match(block, /Wellbeing vs errand openers/i);
    assert.match(block, /Judge the turn first/i);
    assert.match(block, /If you did not catch it/i);
    assert.match(block, /Do not guess/i);
    assert.doesNotMatch(block, /infer intent from the exchange/i);
  });
});
