import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatRoutesForPrompt,
  isSpeechOnlyRetailRoute,
  routesForConversationalRetailPrompt,
  type RoutingLink,
} from './routing_links.js';

const hoursRoute: RoutingLink = {
  id: 'retail-hours',
  presetId: 'hours-enquiry',
  label: 'Opening hours, are you open',
  intent: 'opening hours, are you open',
  targetType: 'callback',
  url: 'Name, phone number, and what they need',
  active: true,
  keywords: 'hours, open, closed, opening times',
};

const cakeRoute: RoutingLink = {
  id: 'retail-bakery-cake',
  presetId: 'quote',
  label: 'Birthday cake, bakery order',
  intent: 'birthday cake, bakery order',
  targetType: 'callback',
  url: 'Name, phone number, cake type',
  active: true,
  keywords: 'birthday cake, bakery',
};

describe('routing_links conversational retail', () => {
  it('detects hours routes as speech-only', () => {
    assert.equal(isSpeechOnlyRetailRoute(hoursRoute), true);
    assert.equal(isSpeechOnlyRetailRoute(cakeRoute), false);
  });

  it('excludes hours routes from conversational retail prompt catalog', () => {
    const filtered = routesForConversationalRetailPrompt([hoursRoute, cakeRoute]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.id, 'retail-bakery-cake');
  });

  it('does not render retail-hours as takeCallbackMessage in filtered prompt', () => {
    const block = formatRoutesForPrompt(routesForConversationalRetailPrompt([hoursRoute, cakeRoute]));
    assert.doesNotMatch(block, /retail-hours/);
    assert.match(block, /retail-bakery-cake/);
    assert.match(block, /takeCallbackMessage/);
  });
});
