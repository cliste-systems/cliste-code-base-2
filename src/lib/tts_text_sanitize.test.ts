import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  prepareGreetingForTts,
  prepareHardcodedSpeechForTts,
  setActiveTtsModelForSanitizer,
} from './tts_text_sanitize.js';

const BLOOM_GREETING =
  "Thanks for calling Bloom Beauty Studio. I'm Cara, the AI assistant. This call may be recorded and transcribed. How can I help you?";

describe('tts_text_sanitize', () => {
  it('flows Bloom greeting clauses with commas', () => {
    const out = prepareGreetingForTts(BLOOM_GREETING);
    assert.match(out, /Thanks for calling Bloom Beauty Studio,/);
    assert.match(out, /how can I help you\?/);
    assert.doesNotMatch(out, /Studio\. I'm/);
  });

  it('softens goodbye for TTS', () => {
    const out = prepareHardcodedSpeechForTts('Thanks for calling, Brandon. Goodbye!');
    assert.match(out, /bye for now/i);
    assert.doesNotMatch(out, /Goodbye!/i);
  });

  it('maps is that alright to okay for TTS (avoids drawn-out alright)', () => {
    const out = prepareHardcodedSpeechForTts(
      "I can text you our booking link — is that alright?",
    );
    assert.match(out, /is that okay/i);
    assert.doesNotMatch(out, /alright/i);
  });

  it('collapses repeated letters that turbo screams', () => {
    const out = prepareHardcodedSpeechForTts('Hellooooo — grand so.');
    assert.match(out, /Hello — grand so/);
    assert.doesNotMatch(out, /Hellooooo/);
  });

  it('applies pronunciation replacements', () => {
    const out = prepareHardcodedSpeechForTts('Book on Fresha.');
    assert.match(out, /Fresh-ah/i);
  });

  it('strips v3 audio tags when model is turbo', () => {
    setActiveTtsModelForSanitizer('eleven_turbo_v2_5');
    const out = prepareHardcodedSpeechForTts('Grand — [pause] lovely.');
    assert.doesNotMatch(out, /\[pause\]/);
    assert.match(out, /Grand — lovely/);
  });

  it('keeps v3 audio tags when model is v3', () => {
    setActiveTtsModelForSanitizer('eleven_v3');
    const out = prepareHardcodedSpeechForTts('Grand — [pause] lovely.');
    assert.match(out, /\[pause\]/);
    setActiveTtsModelForSanitizer('eleven_turbo_v2_5');
  });
});
