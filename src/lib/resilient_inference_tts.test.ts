import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldWrapCartesiaWithElevenFallback } from './resilient_inference_tts.js';

describe('resilient_inference_tts', () => {
  it('wraps Cartesia with Eleven fallback when API key is present', () => {
    assert.equal(shouldWrapCartesiaWithElevenFallback(true, 'test-key'), true);
  });

  it('uses Cartesia only when no Eleven fallback key', () => {
    assert.equal(shouldWrapCartesiaWithElevenFallback(true, null), false);
    assert.equal(shouldWrapCartesiaWithElevenFallback(true, ''), false);
    assert.equal(shouldWrapCartesiaWithElevenFallback(false, 'test-key'), false);
  });
});
