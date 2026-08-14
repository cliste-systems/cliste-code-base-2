import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ANONYMOUS_CALLER_E164,
  blockedCallSpokenMessage,
  callerE164ForBlocklist,
  isAnonymousCallerE164,
} from './caller_blocklist.js';

describe('caller_blocklist', () => {
  it('maps withheld callers to +anonymous', () => {
    assert.equal(callerE164ForBlocklist('anonymous'), ANONYMOUS_CALLER_E164);
    assert.equal(callerE164ForBlocklist(''), ANONYMOUS_CALLER_E164);
  });

  it('normalizes Irish mobile to E.164 for blocklist lookup', () => {
    assert.equal(callerE164ForBlocklist('+353872715938'), '+353872715938');
    assert.equal(callerE164ForBlocklist('0872715938'), '+353872715938');
    assert.equal(callerE164ForBlocklist('sip_+353872715938'), '+353872715938');
  });

  it('detects anonymous sentinel', () => {
    assert.equal(isAnonymousCallerE164(ANONYMOUS_CALLER_E164), true);
    assert.equal(isAnonymousCallerE164('+353872715938'), false);
  });

  it('builds spoken block message with business name', () => {
    const text = blockedCallSpokenMessage('Bloom Beauty Studio');
    assert.match(text, /Bloom Beauty Studio/);
    assert.match(text, /Hello Cara/i);
  });
});
