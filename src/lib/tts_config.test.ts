import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  CARTESIA_SIOBHAN_VOICE_ID,
  DEFAULT_ELEVEN_TTS_MODEL,
  DEFAULT_ELEVEN_VOICE_ID,
  resolveTtsConfig,
} from './tts_config.js';

const cartesiaProfile = {
  id: '1',
  name: 'Cartesia Siobhan (Irish)',
  description: null,
  voice_id: CARTESIA_SIOBHAN_VOICE_ID,
  llm_model: null,
  stt_model: null,
  tts_model: 'cartesia/sonic-3',
  llm_provider: null,
  is_active: true,
};

const elevenProfile = {
  id: '2',
  name: 'Eleven Irish demo',
  description: null,
  voice_id: DEFAULT_ELEVEN_VOICE_ID,
  llm_model: null,
  stt_model: null,
  tts_model: 'eleven_turbo_v2_5',
  llm_provider: null,
  is_active: true,
};

describe('resolveTtsConfig', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.CARA_TTS_PROVIDER = 'cartesia-inference';
    process.env.LIVEKIT_INFERENCE_TTS_MODEL = 'cartesia/sonic-3';
    delete process.env.ELEVEN_VOICE_ID;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('uses ElevenLabs when CARA_TTS_PROVIDER=elevenlabs even if profile is Cartesia', () => {
    process.env.CARA_TTS_PROVIDER = 'elevenlabs';
    process.env.ELEVEN_VOICE_ID = DEFAULT_ELEVEN_VOICE_ID;
    const cfg = resolveTtsConfig({ testProfile: cartesiaProfile, orgVoiceId: null });
    assert.equal(cfg.provider, 'elevenlabs');
    assert.equal(cfg.voiceId, DEFAULT_ELEVEN_VOICE_ID);
    assert.equal(cfg.model, DEFAULT_ELEVEN_TTS_MODEL);
  });

  it('uses Cartesia when profile model is cartesia and env is not elevenlabs', () => {
    const cfg = resolveTtsConfig({ testProfile: cartesiaProfile, orgVoiceId: null });
    assert.equal(cfg.provider, 'cartesia-inference');
    assert.equal(cfg.voiceId, CARTESIA_SIOBHAN_VOICE_ID);
  });

  it('uses Eleven profile voice and model', () => {
    const cfg = resolveTtsConfig({ testProfile: elevenProfile, orgVoiceId: null });
    assert.equal(cfg.provider, 'elevenlabs');
    assert.equal(cfg.voiceId, DEFAULT_ELEVEN_VOICE_ID);
    assert.equal(cfg.model, DEFAULT_ELEVEN_TTS_MODEL);
  });
});
