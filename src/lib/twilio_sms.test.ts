import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { caraSmsDryRunEnabled } from './twilio_sms.js';

describe('twilio_sms', () => {
  const prev = process.env.CARA_SMS_DRY_RUN;

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.CARA_SMS_DRY_RUN;
    } else {
      process.env.CARA_SMS_DRY_RUN = prev;
    }
  });

  it('dry run is off by default', () => {
    delete process.env.CARA_SMS_DRY_RUN;
    assert.equal(caraSmsDryRunEnabled(), false);
  });

  it('dry run enables when CARA_SMS_DRY_RUN=true', () => {
    process.env.CARA_SMS_DRY_RUN = 'true';
    assert.equal(caraSmsDryRunEnabled(), true);
  });
});
