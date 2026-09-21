import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  inferCatalogSearchIntent,
  inferWeeklyOffersListIntent,
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

  it('lets a new stock question override sticky offer context', () => {
    assert.equal(
      resolveCatalogSearchIntent({
        query: "you don't do any Bird's Eye fish fingers at all?",
        callerAskedAboutOffers: true,
      }),
      'stock',
    );
    assert.equal(
      resolveCatalogSearchIntent({
        query: 'do you stock the 14 pack?',
        callerAskedAboutOffers: true,
      }),
      'stock',
    );
  });

  it('keeps bare refinements in the existing offer context', () => {
    assert.equal(
      resolveCatalogSearchIntent({
        query: 'Kelloggs',
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
    trackCallerCatalogSearchIntent('any offers on fish fingers', flags);
    assert.equal(flags.callerAskedAboutOffers, true);
    trackCallerCatalogSearchIntent("you don't do any Bird's Eye fish fingers at all?", flags);
    assert.equal(flags.callerAskedAboutOffers, false);
  });

  it('infers offer intent from query text', () => {
    assert.equal(inferCatalogSearchIntent('McVitie\'s on offer'), 'offer');
    assert.equal(inferCatalogSearchIntent('McVitie\'s'), 'stock');
  });

  it('infers browse intent for weekly offers', () => {
    assert.equal(inferWeeklyOffersListIntent('weekly offers'), true);
    assert.equal(inferWeeklyOffersListIntent('best offers'), true);
    assert.equal(inferWeeklyOffersListIntent('list 5 offers apart from meat'), true);
    assert.equal(inferWeeklyOffersListIntent('steak'), false);
  });
});
