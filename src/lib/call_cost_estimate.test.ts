import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  countAssistantTranscriptChars,
  estimateCallCostUsd,
} from './call_cost_estimate.js';

const ENV_KEYS = [
  'CALL_COST_LIVEKIT_USD_PER_MIN',
  'CALL_COST_STT_USD_PER_MIN',
  'CALL_COST_STT_BILLED_FRACTION_OF_WALL',
  'CALL_COST_LLM_INPUT_TOKENS_PER_MIN',
  'CALL_COST_LLM_OUTPUT_TOKENS_PER_MIN',
  'CALL_COST_LLM_INPUT_USD_PER_1M_TOKENS',
  'CALL_COST_LLM_OUTPUT_USD_PER_1M_TOKENS',
  'CALL_COST_TTS_USD_PER_MIN',
  'CALL_COST_CARTESIA_USD_PER_1M_CHARS',
  'CALL_COST_CARTESIA_SSML_OVERHEAD_FRACTION',
  'CALL_COST_CARTESIA_FALLBACK_USD_PER_MIN',
  'CALL_COST_TWILIO_VOICE_USD_PER_MIN',
  'CALL_COST_ELEVENLABS_USD_PER_MIN',
] as const;

function clearCostEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe('call_cost_estimate', () => {
  afterEach(() => {
    clearCostEnv();
  });

  it('counts assistant transcript characters only', () => {
    const transcript = [
      'Assistant: Hello Kara here.',
      'Caller: Hi',
      'Assistant: How can I help?',
    ].join('\n\n');
    assert.equal(countAssistantTranscriptChars(transcript), 'Hello Kara here.'.length + 'How can I help?'.length);
  });

  it('estimates the 129s demo call near verified billing (~$0.12)', () => {
    const estimate = estimateCallCostUsd({
      durationSeconds: 129,
      smsSegmentsSent: 0,
      didPostprocess: true,
      transcriptChars: 1400,
      assistantTranscriptChars: 1076,
      sttModel: 'assemblyai/universal-3-5-pro',
      llmModel: 'openai/gpt-5.6-luna',
      ttsModel: 'cartesia/sonic-3.6',
    });

    assert.equal(estimate.ratesVersion, '2026-09-11');
    assert.equal(estimate.breakdown.twilioVoice, 0.018);
    assert.ok(estimate.breakdown.tts >= 0.064 && estimate.breakdown.tts <= 0.066);
    assert.ok(estimate.breakdown.stt >= 0.016 && estimate.breakdown.stt <= 0.017);
    assert.ok(estimate.totalUsd >= 0.11 && estimate.totalUsd <= 0.14);
    assert.ok(estimate.totalUsd < 0.2, 'should be well below old $0.33 heuristic');
  });

  it('bills Cartesia TTS per character when assistant chars are known', () => {
    const estimate = estimateCallCostUsd({
      durationSeconds: 60,
      smsSegmentsSent: 0,
      didPostprocess: false,
      transcriptChars: 0,
      assistantTranscriptChars: 1000,
      sttModel: 'assemblyai/universal-3-5-pro',
      llmModel: 'openai/gpt-5.6-luna',
      ttsModel: 'cartesia/sonic-3.6',
    });

    assert.equal(estimate.breakdown.tts, 0.06);
  });

  it('falls back to Cartesia USD/min when assistant chars are missing', () => {
    const estimate = estimateCallCostUsd({
      durationSeconds: 60,
      smsSegmentsSent: 0,
      didPostprocess: false,
      transcriptChars: 0,
      sttModel: 'assemblyai/universal-3-5-pro',
      llmModel: 'openai/gpt-5.6-luna',
      ttsModel: 'cartesia/sonic-3.6',
    });

    assert.equal(estimate.breakdown.tts, 0.04);
  });

  it('rounds Twilio voice up to whole billed minutes', () => {
    const estimate = estimateCallCostUsd({
      durationSeconds: 61,
      smsSegmentsSent: 0,
      didPostprocess: false,
      transcriptChars: 0,
      sttModel: 'assemblyai/universal-3-5-pro',
      llmModel: 'openai/gpt-5.6-luna',
      ttsModel: 'cartesia/sonic-3.6',
    });

    assert.equal(estimate.breakdown.twilioVoice, 0.012);
  });

  it('bills STT for the full call duration by default', () => {
    const estimate = estimateCallCostUsd({
      durationSeconds: 120,
      smsSegmentsSent: 0,
      didPostprocess: false,
      transcriptChars: 0,
      sttModel: 'assemblyai/universal-3-5-pro',
      llmModel: 'openai/gpt-5.6-luna',
      ttsModel: 'cartesia/sonic-3.6',
    });

    assert.equal(estimate.breakdown.stt, 0.015);
  });
});
