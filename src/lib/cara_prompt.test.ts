import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCaraCallPrompt } from './cara_prompt.js';

describe('buildCaraCallPrompt', () => {
  it('includes unlisted-service instruction', () => {
    const prompt = buildCaraCallPrompt({
      businessName: 'Test Salon',
      customPrompt: 'We do cuts.',
      callerLine: {
        kind: 'irish_mobile',
        e164: '+353871234567',
        spoken: 'oh-eight-seven, one-two-three, four-five-six-seven',
        display: '087 123 4567',
        canReceiveSms: true,
        hint: 'Caller ID on file.',
      },
      routingLinks: [],
      bookingTimeZone: 'Europe/Dublin',
      nowUtcIso: '2026-06-20T12:00:00.000Z',
      todayLocal: '2026-06-20',
    });

    assert.match(prompt, /do \*\*not\*\* guess yes or no/i);
    assert.match(prompt, /takeCallbackMessage/i);
  });
});
