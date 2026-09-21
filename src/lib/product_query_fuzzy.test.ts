import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildProductFallbackQueries,
  fuzzyProductMatchScore,
  inferExplicitProductFulfilment,
  pickConfidentFuzzyProductMatch,
} from './product_query_fuzzy.js';

describe('retail product query fuzzy recovery', () => {
  it('adds a possessive/plural-safe stem fallback for brand names', () => {
    assert.deepEqual(buildProductFallbackQueries('Kelloggs'), ['kelloggs', 'kellogg']);
  });


  it('treats filled steak as a strong near-match for fillet steak', () => {
    const fillet = fuzzyProductMatchScore(
      'filled steak',
      'SuperValu Signature Tastes Hereford Irish Fillet Steak (370 g)',
    );
    const striploin = fuzzyProductMatchScore(
      'filled steak',
      'SuperValu Signature Tastes Irish Striploin Steak (450 g)',
    );
    assert.ok(fillet > 0.85);
    assert.ok(fillet > striploin + 0.25);
  });

  it('picks fillet from broad steak candidates after an STT slip', () => {
    const match = pickConfidentFuzzyProductMatch('filled steak', [
      { product_name: 'SuperValu Fresh Irish Beef Sirloin Steak (1 kg)' },
      { product_name: 'SuperValu Signature Tastes Hereford Irish Fillet Steak (370 g)' },
      { product_name: 'SuperValu Salt & Chilli Beef Quick Fry Steaks (380 g)' },
    ]);
    assert.match(match?.product_name ?? '', /Fillet Steak/i);
  });

  it('does not guess when broad candidates are genuinely ambiguous', () => {
    const match = pickConfidentFuzzyProductMatch('steak', [
      { product_name: 'SuperValu Fresh Irish Beef Sirloin Steak (1 kg)' },
      { product_name: 'SuperValu Signature Tastes Hereford Irish Fillet Steak (370 g)' },
    ]);
    assert.equal(match, null);
  });

  it('keeps fulfilment current-turn explicit', () => {
    assert.equal(inferExplicitProductFulfilment('fillet steak'), undefined);
    assert.equal(inferExplicitProductFulfilment('fillet steak at the meat counter'), 'counter');
    assert.equal(inferExplicitProductFulfilment('pre-pack fillet steak'), 'prepack');
  });

  it('creates narrow fallback searches without offer boilerplate', () => {
    assert.deepEqual(buildProductFallbackQueries('is there any filled steak on offer?'), [
      'filled',
      'steak',
    ]);
  });
});
