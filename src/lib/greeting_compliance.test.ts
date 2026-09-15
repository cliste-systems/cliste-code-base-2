import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  greetingDisclosesAi,
  greetingIncludesAiDisclosure,
  spokenTextIncludesRecordingNotice,
} from './greeting_compliance.js';
import { voiceLegalDisclosure } from './voice_legal_disclosure.js';

describe('greetingDisclosesAi', () => {
  it('accepts canonical voiceLegalDisclosure wording', () => {
    const greeting = `You're through to Test Store — ${voiceLegalDisclosure('Cara')} How can I help?`;
    assert.equal(greetingDisclosesAi(greeting, 'Cara'), true);
  });

  it('rejects ai assistant without recording notice', () => {
    assert.equal(
      greetingDisclosesAi("You're through to Test Store — I'm Cara, the AI assistant.", 'Cara'),
      false,
    );
  });

  it('does not treat ai assistant alone as sufficient', () => {
    assert.equal(greetingIncludesAiDisclosure("I'm Cara, the AI assistant."), false);
  });
});

describe('spokenTextIncludesRecordingNotice', () => {
  it('detects demo-style recording awareness', () => {
    assert.equal(
      spokenTextIncludesRecordingNotice(
        "Lovely, Martin — just so you're aware, this demo's recorded, yeah?",
      ),
      true,
    );
  });
});
