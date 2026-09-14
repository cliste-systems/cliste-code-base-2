import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOOKUP_FILLER_PHRASES,
  callerUtteranceLikelyNeedsProductLookup,
  looksLikeLookupFillerSpeech,
  nextLookupFillerPhrase,
  resolveLookupFillerDelayMs,
} from './lookup_filler.js';

describe('lookup_filler', () => {
  it('rotates through phrases', () => {
    assert.equal(nextLookupFillerPhrase(0), LOOKUP_FILLER_PHRASES[0]);
    assert.equal(nextLookupFillerPhrase(1), LOOKUP_FILLER_PHRASES[1]);
    assert.equal(
      nextLookupFillerPhrase(LOOKUP_FILLER_PHRASES.length),
      LOOKUP_FILLER_PHRASES[0],
    );
  });

  it('detects lookup-style assistant speech', () => {
    assert.equal(
      looksLikeLookupFillerSpeech('Right — let me have a look for you.'),
      true,
    );
    assert.equal(looksLikeLookupFillerSpeech('We have Birds Eye fish fingers on offer.'), false);
  });

  it('uses zero retail lookup delay to avoid barge-in loops', () => {
    const prev = process.env.LIVEKIT_RESPONSE_FILLER_MS;
    delete process.env.LIVEKIT_RESPONSE_FILLER_MS;
    assert.equal(
      resolveLookupFillerDelayMs({
        conversationalRetailLine: true,
        demoExperienceStack: false,
      }),
      0,
    );
    if (prev !== undefined) process.env.LIVEKIT_RESPONSE_FILLER_MS = prev;
  });

  it('detects product lookup caller phrasing', () => {
    assert.equal(callerUtteranceLikelyNeedsProductLookup('do you sell egg noodles'), true);
    assert.equal(callerUtteranceLikelyNeedsProductLookup('what time do you close'), false);
  });
});
