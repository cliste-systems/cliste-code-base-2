import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isFactoryFreshLine, primaryFactoryFreshCalledNumber } from './factory_fresh_line.js';

describe('factory_fresh_line', () => {
  it('does not treat the retail demo line as factory fresh', () => {
    assert.equal(isFactoryFreshLine('+353749759508'), false);
    assert.equal(isFactoryFreshLine('353749759508'), false);
  });

  it('does not treat the public demo line as factory fresh', () => {
    assert.equal(isFactoryFreshLine('+353749389378'), false);
  });

  it('detects env-configured factory fresh numbers', () => {
    const prev = process.env.CARA_FACTORY_FRESH_CALLED_NUMBERS;
    process.env.CARA_FACTORY_FRESH_CALLED_NUMBERS = '+353749759509';
    try {
      assert.equal(isFactoryFreshLine('+353749759509'), true);
      assert.equal(primaryFactoryFreshCalledNumber(), '+353749759509');
    } finally {
      if (prev === undefined) delete process.env.CARA_FACTORY_FRESH_CALLED_NUMBERS;
      else process.env.CARA_FACTORY_FRESH_CALLED_NUMBERS = prev;
    }
  });
});
