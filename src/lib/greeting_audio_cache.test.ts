import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { initializeLogger } from '@livekit/agents';

import { pcmSampleRateFromEncoding, pcmToAudioFrameStream } from './greeting_audio_cache.js';

initializeLogger({ level: 'warn', pretty: false });

describe('pcmToAudioFrameStream', () => {
  it('yields frames with correct sample rate, channels, and samplesPerChannel', async () => {
    const sampleRate = 24_000;
    const numSamples = 4800;
    const pcm = new Uint8Array(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      const view = new DataView(pcm.buffer);
      view.setInt16(i * 2, i % 256, true);
    }

    const stream = pcmToAudioFrameStream(pcm, sampleRate);
    const reader = stream.getReader();
    const frames = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      frames.push(value);
    }

    assert.ok(frames.length > 0, 'expected at least one audio frame');
    for (const frame of frames) {
      assert.equal(frame.sampleRate, sampleRate);
      assert.equal(frame.channels, 1);
      assert.equal(frame.samplesPerChannel, frame.data.length);
    }

    const totalSamples = frames.reduce((n, f) => n + f.samplesPerChannel, 0);
    assert.equal(totalSamples, numSamples);
  });
});

describe('pcmSampleRateFromEncoding', () => {
  it('parses rate from encoding string', () => {
    assert.equal(pcmSampleRateFromEncoding('pcm_24000'), 24_000);
    assert.equal(pcmSampleRateFromEncoding('pcm_48000'), 48_000);
    assert.equal(pcmSampleRateFromEncoding(undefined), 24_000);
  });
});
