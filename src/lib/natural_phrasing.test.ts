import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assistantAskedWindDown,
  buildDemoCallClosingLine,
  buildWarmCallClosingLine,
  buildWindDownPrompt,
  demoOutroTimePhrase,
  inferDemoCallerFirstName,
  softenSpokenFarewell,
} from './natural_phrasing.js';

describe('natural_phrasing', () => {
  it('rotates wind-down prompts from seed', () => {
    const a = buildWindDownPrompt('call-123');
    const b = buildWindDownPrompt('call-456');
    assert.match(a, /\?$/);
    assert.match(b, /\?$/);
    assert.notEqual(a, b);
  });

  it('detects varied wind-down questions', () => {
    assert.equal(assistantAskedWindDown('Can I help with anything else at all?'), true);
    assert.equal(assistantAskedWindDown('Are you all sorted?'), true);
    assert.equal(assistantAskedWindDown('What service would you like?'), false);
  });

  it('softens bare farewells', () => {
    assert.equal(softenSpokenFarewell('Bye.'), 'Take care.');
    assert.equal(softenSpokenFarewell('Lovely — thanks. Bye'), 'Lovely — thanks. Take care.');
  });

  it('rotates closing lines from seed', () => {
    const a = buildWarmCallClosingLine("Murphy's SuperValu", 'seed-a');
    const b = buildWarmCallClosingLine("Murphy's SuperValu", 'seed-b');
    assert.match(a, /Murphy's SuperValu/);
    assert.match(b, /Murphy's SuperValu/);
    assert.doesNotMatch(a, /\bbye\b/i);
    assert.doesNotMatch(b, /\bbye\b/i);
  });

  it('builds Hello Cara outro with name and time of day', () => {
    const day = buildDemoCallClosingLine('seed-a', 'Abigail', 14);
    assert.match(day, /Abigail/);
    assert.match(day, /thanks for calling Hello Cara today/i);
    assert.match(day, /Have a good day/i);
    assert.match(day, /Bye for now/i);
    assert.doesNotMatch(day, /\bgrand\b/i);
    assert.doesNotMatch(day, /\bsound\b/i);

    const evening = buildDemoCallClosingLine('seed-a', 'Abigail', 18);
    assert.match(evening, /Have a good evening/i);
  });

  it('uses day outro before 5pm Dublin hour', () => {
    assert.equal(demoOutroTimePhrase(16), 'day');
    assert.equal(demoOutroTimePhrase(17), 'evening');
  });

  it('infers demo caller first name from intro lines', () => {
    assert.equal(inferDemoCallerFirstName(['Hello there, my name is Mary.']), 'Mary');
    assert.equal(inferDemoCallerFirstName(['Mary']), 'Mary');
    assert.equal(inferDemoCallerFirstName(['Hello there']), null);
  });
});
