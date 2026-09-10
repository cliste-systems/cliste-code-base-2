import { AudioByteStream } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';

/** Brief dual-tone handset hangup — 24 kHz mono PCM (PSTN-ish). */
export function buildPhoneHangupTonePcm(sampleRate = 24_000): Uint8Array {
  const durationSec = 0.28;
  const sampleCount = Math.floor(sampleRate * durationSec);
  const pcm = new Int16Array(sampleCount);
  const f1 = 480;
  const f2 = 620;
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const attack = Math.min(1, i / (sampleRate * 0.012));
    const decay = Math.min(1, (sampleCount - i) / (sampleRate * 0.09));
    const env = attack * decay;
    const sample =
      (Math.sin(2 * Math.PI * f1 * t) * 0.55 + Math.sin(2 * Math.PI * f2 * t) * 0.45) *
      0.42 *
      env;
    pcm[i] = Math.max(-32_767, Math.min(32_767, Math.round(sample * 32_767)));
  }
  return new Uint8Array(pcm.buffer);
}

export function phoneHangupToneFrameStream(sampleRate = 24_000): ReadableStream<AudioFrame> {
  const byteStream = new AudioByteStream(sampleRate, 1);
  const frames = [...byteStream.write(buildPhoneHangupTonePcm(sampleRate)), ...byteStream.flush()];
  return ReadableStream.from(frames);
}
