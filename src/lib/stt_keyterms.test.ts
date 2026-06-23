import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
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

  it('includes static booking phrases and catalog names', () => {
    const terms = buildSttKeyterms({
      orgName: 'Bloom Beauty Studio',
      customPrompt: 'Services menu:\n• Root Touch-up — 60 min — from €65',
    });
    assert.ok(terms.includes('hair appointment'));
    assert.ok(terms.includes('appointment'));
    assert.ok(terms.includes('root touch-up'));
    assert.ok(terms.includes('Bloom'));
  });

  it('builds u3 domain prompt with org name', () => {
    const p = buildSttDomainPrompt('Bloom Beauty Studio');
    assert.match(p, /Bloom Beauty Studio/);
    assert.match(p, /hair appointment/);
  });

  it('uses prompt for u3-rt-pro and keyterms for universal-streaming', () => {
    const keyterms = ['hair', 'haircut'];
    const domain = 'Salon calls.';
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
