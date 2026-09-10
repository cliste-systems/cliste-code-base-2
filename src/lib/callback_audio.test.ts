import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { caraTypingSoundEnabled } from './callback_audio.js';

describe('callback_audio', () => {
  it('typing sound is off by default', () => {
    const prev = process.env.CARA_TYPING_SOUND;
    delete process.env.CARA_TYPING_SOUND;
    assert.equal(caraTypingSoundEnabled(), false);
    process.env.CARA_TYPING_SOUND = 'false';
    assert.equal(caraTypingSoundEnabled(), false);
    process.env.CARA_TYPING_SOUND = 'true';
    assert.equal(caraTypingSoundEnabled(), true);
    process.env.CARA_TYPING_SOUND = '1';
    assert.equal(caraTypingSoundEnabled(), true);
    process.env.CARA_TYPING_SOUND = 'on';
    assert.equal(caraTypingSoundEnabled(), true);
    if (prev === undefined) delete process.env.CARA_TYPING_SOUND;
    else process.env.CARA_TYPING_SOUND = prev;
  });
});
