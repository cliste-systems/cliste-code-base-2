import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isElevenV3Model,
  sanitizeVoiceSettingsForModel,
} from './elevenlabs-v3-http-tts.js';

describe('elevenlabs-v3-http-tts', () => {
  it('detects v3 models', () => {
    assert.equal(isElevenV3Model('eleven_v3'), true);
    assert.equal(isElevenV3Model('eleven_v3_alpha'), true);
    assert.equal(isElevenV3Model('eleven_turbo_v2_5'), false);
  });

  it('strips speed and speaker_boost for v3 requests', () => {
    const cleaned = sanitizeVoiceSettingsForModel('eleven_v3', {
      stability: 0.55,
      similarity_boost: 0.78,
      style: 0.2,
      speed: 0.93,
      use_speaker_boost: false,
    });
    assert.deepEqual(cleaned, {
      stability: 0.55,
      similarity_boost: 0.78,
      style: 0.2,
    });
  });

  it('keeps turbo voice settings intact', () => {
    const settings = {
      stability: 0.55,
      similarity_boost: 0.78,
      style: 0.2,
      speed: 0.93,
      use_speaker_boost: false,
    };
    assert.deepEqual(sanitizeVoiceSettingsForModel('eleven_turbo_v2_5', settings), settings);
  });
});
