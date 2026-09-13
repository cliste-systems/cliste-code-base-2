import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectLikelySttGarble,
  isPhantomCallerTranscript,
  soundsLikeSubstantiveServiceAnswer,
} from './stt_garble.js';

describe('stt_garble', () => {
  it('flags garbled cake order phrasing', () => {
    const text = 'order of cake please';
    assert.equal(detectLikelySttGarble(text), true);
  });

  it('accepts clean retail question without garble flag', () => {
    const text = 'Hi, are you open tomorrow?';
    assert.equal(detectLikelySttGarble(text), false);
  });

  it('treats um as phantom transcript', () => {
    assert.equal(isPhantomCallerTranscript('um'), true);
  });

  it('accepts substantive retail answers', () => {
    assert.equal(
      soundsLikeSubstantiveServiceAnswer('I need to check stock on the bakery counter'),
      true,
    );
  });
});
