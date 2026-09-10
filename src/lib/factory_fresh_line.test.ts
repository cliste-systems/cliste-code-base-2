import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isFactoryFreshLine, primaryFactoryFreshCalledNumber } from './factory_fresh_line.js';

describe('factory_fresh_line', () => {
  it('detects the spare Irish baseline number', () => {
    assert.equal(isFactoryFreshLine('+353749759508'), true);
    assert.equal(isFactoryFreshLine('353749759508'), true);
  });

  it('does not treat the public demo line as factory fresh', () => {
    assert.equal(isFactoryFreshLine('+353749389378'), false);
  });

  it('exposes primary factory fresh number', () => {
    assert.equal(primaryFactoryFreshCalledNumber(), '+353749759508');
  });
});
