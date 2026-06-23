import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectLikelySttGarble,
  isPhantomCallerTranscript,
  soundsLikeBookingIntent,
  soundsLikeSubstantiveServiceAnswer,
} from './stt_garble.js';

describe('stt_garble', () => {
  it('flags R appointment as garble and booking intent', () => {
    const text = 'R appointment. Please.';
    assert.equal(detectLikelySttGarble(text), true);
    assert.equal(soundsLikeBookingIntent(text), true);
  });

  it('flags book for the quote as garble and booking intent', () => {
    const text = 'Can I book for the quote? Please?';
    assert.equal(detectLikelySttGarble(text), true);
    assert.equal(soundsLikeBookingIntent(text), true);
  });

  it('accepts clean hair appointment without garble flag', () => {
    const text = 'Hi, I want a hair appointment please.';
    assert.equal(detectLikelySttGarble(text), false);
    assert.equal(soundsLikeBookingIntent(text), true);
  });

  it('does not treat cancel appointment as booking intent', () => {
    assert.equal(soundsLikeBookingIntent('I need to cancel my appointment'), false);
  });

  it('ignores phantom STT fragments', () => {
    assert.equal(isPhantomCallerTranscript('6.'), true);
    assert.equal(isPhantomCallerTranscript('um'), true);
    assert.equal(isPhantomCallerTranscript('Yes, sir, book for my mother'), false);
  });

  it('accepts substantive service answers', () => {
    assert.equal(soundsLikeSubstantiveServiceAnswer("she's looking for a balayage"), true);
    assert.equal(soundsLikeSubstantiveServiceAnswer('book for my mother'), false);
    assert.equal(
      soundsLikeSubstantiveServiceAnswer('Um, I was looking at booking a root touch-up, please.'),
      true,
    );
  });
});
