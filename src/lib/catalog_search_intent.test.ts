import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  inferCatalogSearchIntent,
  resolveCatalogSearchIntent,
  trackCallerCatalogSearchIntent,
} from './catalog_search_intent.js';

describe('catalog search intent', () => {
  it('uses session offer flag when query is bare product name', () => {
    assert.equal(
      resolveCatalogSearchIntent({
        query: 'biscuits',
        callerAskedAboutOffers: true,
      }),
      'offer',
    );
  });

  it('prefers explicit price intent over session offer flag', () => {
    assert.equal(
      resolveCatalogSearchIntent({
        query: 'Weetabix',
        explicitIntent: 'price',
        callerAskedAboutOffers: true,
      }),
      'price',
    );
  });

  it('tracks offer phrasing on caller turns', () => {
    const flags: { callerAskedAboutOffers?: boolean } = {};
    trackCallerCatalogSearchIntent('any offer on biscuits this week', flags);
    assert.equal(flags.callerAskedAboutOffers, true);
    trackCallerCatalogSearchIntent('how much is the Weetabix', flags);
    assert.equal(flags.callerAskedAboutOffers, false);
  });

  it('infers offer intent from query text', () => {
    assert.equal(inferCatalogSearchIntent('McVitie\'s on offer'), 'offer');
    assert.equal(inferCatalogSearchIntent('McVitie\'s'), 'stock');
  });
});
