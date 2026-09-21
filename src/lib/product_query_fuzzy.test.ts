import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyProductSelectionPreference,
  buildProductFallbackQueries,
  combineProductRefinementQuery,
  fuzzyProductMatchScore,
  inferExplicitProductFulfilment,
  inferProductSelectionPreference,
  pickConfidentFuzzyProductMatch,
  resolveEffectiveProductFulfilment,
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

  it('honors the model fulfilment on the same turn after product wording is normalized', () => {
    assert.equal(resolveEffectiveProductFulfilment('salmon', 'counter'), 'counter');
    assert.equal(resolveEffectiveProductFulfilment('sirloin', 'counter'), 'counter');
    assert.equal(resolveEffectiveProductFulfilment('salmon at the fish counter', 'prepack'), 'counter');
    assert.equal(resolveEffectiveProductFulfilment('salmon', undefined), undefined);
  });

  it('creates narrow fallback searches without offer boilerplate', () => {
    assert.deepEqual(buildProductFallbackQueries('is there any filled steak on offer?'), [
      'filled',
      'steak',
    ]);
  });

  it('adds bounded fragments for a single misspelled product token', () => {
    const fallbacks = buildProductFallbackQueries('avacado');
    assert.equal(fallbacks[0], 'avacado');
    assert.ok(fallbacks.includes('cado'));
  });

  it('scores common avocado spelling slips as confident near matches once candidates are recovered', () => {
    const score = fuzzyProductMatchScore(
      'avacado',
      'SuperValu Signature Tastes Ripe & Ready Avocado (1 Piece)',
    );
    assert.ok(score >= 0.78);
  });

  it('keeps broad offer context behind the caller refinement', () => {
    assert.equal(combineProductRefinementQuery('alcohol', 'wine'), 'wine alcohol');
  });

  it('preserves own-brand refinement while stripping cheapest from search text', () => {
    assert.equal(
      combineProductRefinementQuery('avocado', 'fresh supervalu brand cheapest'),
      'fresh supervalu brand avocado',
    );
    assert.equal(inferProductSelectionPreference('fresh supervalu brand cheapest'), 'cheapest');
  });

  it('selects the cheapest priced relevant match generically', () => {
    const selected = applyProductSelectionPreference(
      [
        { product_name: 'Option A', current_price_eur: 2.89 },
        { product_name: 'Option B', current_price_eur: 0.99 },
        { product_name: 'Option C', current_price_eur: 1.59 },
      ],
      'cheapest',
    );
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.product_name, 'Option B');
  });

});
