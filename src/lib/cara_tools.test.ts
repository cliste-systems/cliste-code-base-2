import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CaraTools } from './cara_tools.js';

describe('CaraTools.toolContext', () => {
  it('exposes only endPhoneCall on conversational retail 9508', () => {
    const tools = new CaraTools().toolContext({ conversationalRetailLine: true });
    assert.deepEqual(Object.keys(tools).sort(), ['endPhoneCall']);
  });

  it('exposes only endPhoneCall on demo line', () => {
    const tools = new CaraTools().toolContext({ demoLine: true });
    assert.deepEqual(Object.keys(tools).sort(), ['endPhoneCall']);
  });

  it('keeps full production tool surface on default lines', () => {
    const tools = new CaraTools().toolContext();
    assert.ok('takeCallbackMessage' in tools);
    assert.ok('sendDirectionsLink' in tools);
    assert.ok('endPhoneCall' in tools);
  });
});
