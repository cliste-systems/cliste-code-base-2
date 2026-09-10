import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assemblyAiTurnSilenceDefaults,
  buildSttDomainPrompt,
  buildSttKeyterms,
  buildAssemblyAiSttOptions,
  endpointingDefaults,
  parseServiceNamesFromCustomPrompt,
  resolveSttLatencyProfile,
  sttTurnSilenceDefaults,
} from './stt_keyterms.js';

describe('stt_keyterms', () => {
  it('parses service names from Services menu bullets', () => {
    const prompt = `Services menu:
• Ladies Cut — 45 min — from €45
• Gel Manicure — 45 min — from €38
When someone asks how long a service takes`;
    assert.deepEqual(parseServiceNamesFromCustomPrompt(prompt), [
      'Ladies Cut',
      'Gel Manicure',
    ]);
  });

  it('includes retail opening-hours keyterms', () => {
    const terms = buildSttKeyterms({
      orgName: "Murphy's SuperValu Killarney",
      niche: 'retail',
    });
    assert.ok(terms.includes('are ye open'));
    assert.ok(terms.includes('open tomorrow'));
    assert.ok(terms.includes('SuperValu'));
  });

  it('builds retail domain prompt', () => {
    const p = buildSttDomainPrompt("Murphy's SuperValu Killarney", { niche: 'retail' });
    assert.match(p, /retail grocery store/i);
    assert.match(p, /are ye open/i);
    assert.doesNotMatch(p, /salon/i);
  });

  it('uses prompt for u3-rt-pro and keyterms for universal-streaming', () => {
    const keyterms = ['deli', 'butcher'];
    const domain = 'Retail store calls.';
    const u3 = buildAssemblyAiSttOptions({
      model: 'assemblyai/u3-rt-pro',
      keyterms,
      domainPrompt: domain,
      minTurnSilenceMs: 300,
      maxTurnSilenceMs: 1400,
      eotConfidence: 0.4,
    });
    assert.equal(u3.prompt, domain);
    assert.equal(u3.keyterms_prompt, undefined);

    const legacy = buildAssemblyAiSttOptions({
      model: 'assemblyai/universal-streaming',
      keyterms,
      domainPrompt: domain,
      minTurnSilenceMs: 300,
      maxTurnSilenceMs: 1400,
      eotConfidence: 0.4,
    });
    assert.deepEqual(legacy.keyterms_prompt, keyterms);
    assert.equal(legacy.prompt, undefined);
  });

  it('u3-rt-pro uses LiveKit turn-detector silence tuning', () => {
    assert.deepEqual(assemblyAiTurnSilenceDefaults('assemblyai/u3-rt-pro', 'snappy'), {
      minTurnSilenceMs: 100,
      maxTurnSilenceMs: 100,
      eotConfidence: 0.35,
    });
  });

  it('snappy profile zeros stacked endpointing on u3 neural STT', () => {
    assert.equal(resolveSttLatencyProfile('snappy'), 'snappy');
    assert.deepEqual(sttTurnSilenceDefaults('snappy'), {
      minTurnSilenceMs: 200,
      maxTurnSilenceMs: 1000,
      eotConfidence: 0.35,
    });
    assert.deepEqual(endpointingDefaults('snappy', true), {
      minDelayMs: 0,
      maxDelayMs: 0,
    });
  });

  it('balanced profile restores prior latency tuning', () => {
    assert.equal(resolveSttLatencyProfile('balanced'), 'balanced');
    assert.deepEqual(sttTurnSilenceDefaults('balanced'), {
      minTurnSilenceMs: 300,
      maxTurnSilenceMs: 1400,
      eotConfidence: 0.4,
    });
    assert.deepEqual(endpointingDefaults('balanced', true), {
      minDelayMs: 80,
      maxDelayMs: 900,
    });
  });
});
