import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CARTESIA_SIOBHAN_VOICE_ID, resolveTtsConfig } from './tts_config.js';

const cartesiaProfile = {
  id: 'profile-cartesia',
  name: 'Cartesia test',
  description: 'Cartesia inference profile',
  voice_id: CARTESIA_SIOBHAN_VOICE_ID,
  llm_model: 'google/gemma-4-31b-it',
  stt_model: 'assemblyai/universal-3-5-pro',
  tts_model: 'cartesia/sonic-3.6',
  llm_provider: 'gateway',
  is_active: true,
};

describe('tts_config', () => {
  it('defaults to Cartesia Siobhan via LiveKit Inference', () => {
    const cfg = resolveTtsConfig({ testProfile: null, orgVoiceId: null });
    assert.equal(cfg.model, 'cartesia/sonic-3.6');
    assert.equal(cfg.voiceId, CARTESIA_SIOBHAN_VOICE_ID);
    assert.match(cfg.label, /cartesia\/sonic-3\.6/);
  });

  it('uses profile cartesia model and voice when set', () => {
    const cfg = resolveTtsConfig({ testProfile: cartesiaProfile, orgVoiceId: null });
    assert.equal(cfg.model, 'cartesia/sonic-3.6');
    assert.equal(cfg.voiceId, CARTESIA_SIOBHAN_VOICE_ID);
  });

  it('respects LIVEKIT_INFERENCE_TTS_MODEL env override', () => {
    const prev = process.env.LIVEKIT_INFERENCE_TTS_MODEL;
    process.env.LIVEKIT_INFERENCE_TTS_MODEL = 'cartesia/sonic-3.6';
    try {
      const cfg = resolveTtsConfig({ testProfile: null, orgVoiceId: null });
      assert.equal(cfg.model, 'cartesia/sonic-3.6');
    } finally {
      if (prev === undefined) delete process.env.LIVEKIT_INFERENCE_TTS_MODEL;
      else process.env.LIVEKIT_INFERENCE_TTS_MODEL = prev;
    }
  });
});
