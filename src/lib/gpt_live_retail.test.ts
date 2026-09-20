import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGptLiveRetailOpeningInstructions,
  GPT_LIVE_RETAIL_VOICE_DEFAULT,
  resolveGptLiveRetailVoice,
  shouldUseGptLiveRetailStack,
} from './gpt_live_retail.js';

describe('gpt_live_retail', () => {
  it('enables GPT-Live on conversational retail by default', () => {
    const prev = process.env.CARA_GPT_LIVE_RETAIL;
    delete process.env.CARA_GPT_LIVE_RETAIL;
    try {
      assert.equal(shouldUseGptLiveRetailStack({ conversationalRetailLine: true }), true);
      assert.equal(shouldUseGptLiveRetailStack({ conversationalRetailLine: false }), false);
    } finally {
      if (prev === undefined) delete process.env.CARA_GPT_LIVE_RETAIL;
      else process.env.CARA_GPT_LIVE_RETAIL = prev;
    }
  });

  it('can disable GPT-Live via env', () => {
    const prev = process.env.CARA_GPT_LIVE_RETAIL;
    process.env.CARA_GPT_LIVE_RETAIL = '0';
    try {
      assert.equal(shouldUseGptLiveRetailStack({ conversationalRetailLine: true }), false);
    } finally {
      if (prev === undefined) delete process.env.CARA_GPT_LIVE_RETAIL;
      else process.env.CARA_GPT_LIVE_RETAIL = prev;
    }
  });

  it('defaults voice to willow', () => {
    const prev = process.env.CARA_GPT_LIVE_VOICE;
    delete process.env.CARA_GPT_LIVE_VOICE;
    try {
      assert.equal(resolveGptLiveRetailVoice(), GPT_LIVE_RETAIL_VOICE_DEFAULT);
    } finally {
      if (prev === undefined) delete process.env.CARA_GPT_LIVE_VOICE;
      else process.env.CARA_GPT_LIVE_VOICE = prev;
    }
  });

  it('builds opening instructions from greeting text', () => {
    const instructions = buildGptLiveRetailOpeningInstructions(
      "Hello, you're through to Kavanaghs. I'm Cara.",
    );
    assert.match(instructions, /Irish English/);
    assert.match(instructions, /Kavanaghs/);
  });
});
