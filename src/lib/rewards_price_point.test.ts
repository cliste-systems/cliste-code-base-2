import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRewardsPricePointMatches,
  formatSpokenRewardsPrice,
  inferRewardsPricePoint,
} from './rewards_price_point.js';

describe('Rewards price-point lookup', () => {
  it('parses numeric and spoken Rewards price points', () => {
    assert.equal(inferRewardsPricePoint("What's on Rewards Price for €2.50?"), 2.5);
    assert.equal(inferRewardsPricePoint('What offers are 2.50 with Real Rewards?'), 2.5);
    assert.equal(inferRewardsPricePoint('Anything with Rewards at two fifty?'), 2.5);
    assert.equal(inferRewardsPricePoint('Any Real Rewards offers for two euro fifty?'), 2.5);
    assert.equal(inferRewardsPricePoint('two fifty'), null);
  });

  it('formats spoken euro prices for Cara', () => {
    assert.equal(formatSpokenRewardsPrice(2.5), 'two euro fifty');
    assert.equal(formatSpokenRewardsPrice(5), 'five euro');
    assert.equal(formatSpokenRewardsPrice(0.99), 'ninety nine cents');
  });

  it('keeps only exact Rewards price matches and prefers non-alcohol first', () => {
    const matches = buildRewardsPricePointMatches(
      [
        {
          product_name: 'Two Tracks Sauvignon Blanc',
          department: 'Wine',
          sku: 'wine-11',
          current_price_eur: 11,
          was_price_eur: 12,
          discount_label: 'Rewards Price',
          service_area: 'off_licence',
          fulfilment: 'prepack',
          is_alcohol: true,
        },
        {
          product_name: 'Aquafresh Toothpaste',
          department: 'Dental Care',
          sku: 'toothpaste-250',
          current_price_eur: 2.5,
          was_price_eur: 5,
          discount_label: 'Rewards Price Only €2.50',
          service_area: 'grocery',
          fulfilment: 'prepack',
          is_alcohol: false,
        },
        {
          product_name: 'Ordinary €2.50 Deal',
          department: 'Grocery',
          sku: 'ordinary-250',
          current_price_eur: 2.5,
          was_price_eur: 3,
          discount_label: 'Only €2.50',
          service_area: 'grocery',
          fulfilment: 'prepack',
          is_alcohol: false,
        },
        {
          product_name: 'Absolut Ready to Drink',
          department: 'Alcohol',
          sku: 'alcohol-250',
          current_price_eur: 2.5,
          was_price_eur: 3,
          discount_label: 'Rewards Price Only €2.50',
          service_area: 'off_licence',
          fulfilment: 'prepack',
          is_alcohol: true,
        },
      ],
      2.5,
    );

    assert.deepEqual(matches.map((match) => match.product_name), [
      'Aquafresh Toothpaste',
      'Absolut Ready to Drink',
    ]);
    assert.doesNotMatch(matches.map((match) => match.quote_text).join(' '), /eleven euro/i);
    assert.match(matches[0]?.quote_text ?? '', /Rewards Price two euro fifty/i);
  });
});
