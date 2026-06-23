import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AudioFrame } from '@livekit/rtc-node';
import { tokenize } from '@livekit/agents';

import {
  type ElevenLabsHttpV3Config,
  renderTextToPcmWithV3,
} from './elevenlabs-v3-http-tts.js';
import { prepareGreetingForTts } from './tts_text_sanitize.js';

const GREETING_V3_MODEL = 'eleven_v3';
const DEFAULT_CACHE_DIR = '/tmp/greeting-cache';

export function greetingAudioCacheKey(
  orgId: string,
  greetingText: string,
  voiceId: string,
): string {
  return createHash('sha256')
    .update(`${orgId}\0${greetingText.trim()}\0${voiceId.trim()}`)
    .digest('hex');
}

function cacheDir(): string {
  return process.env.GREETING_AUDIO_CACHE_DIR?.trim() || DEFAULT_CACHE_DIR;
}

function cacheFilePath(cacheKey: string): string {
  return join(cacheDir(), `${cacheKey}.pcm`);
}

export async function loadCachedGreetingPcm(cacheKey: string): Promise<Uint8Array | null> {
  try {
    const data = await readFile(cacheFilePath(cacheKey));
    return data.byteLength > 0 ? new Uint8Array(data) : null;
  } catch {
    return null;
  }
}

export async function storeCachedGreetingPcm(cacheKey: string, pcm: Uint8Array): Promise<void> {
  if (!pcm.byteLength) {
    return;
  }
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(cacheFilePath(cacheKey), pcm);
}

export function pcmToAudioFrameStream(
  pcm: Uint8Array,
  sampleRate: number,
): ReadableStream<AudioFrame> {
  const generator = pcmToAudioFrames(pcm, sampleRate);
  return new ReadableStream<AudioFrame>({
    async pull(controller) {
      const { value, done } = await generator.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel() {
      void generator.return(undefined);
    },
  });
}

export async function* pcmToAudioFrames(
  pcm: Uint8Array,
  sampleRate: number,
): AsyncGenerator<AudioFrame> {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  const frameSamples = Math.max(1, Math.floor(sampleRate / 50));
  for (let i = 0; i < samples.length; i += frameSamples) {
    const chunk = samples.subarray(i, Math.min(i + frameSamples, samples.length));
    yield new AudioFrame(chunk, sampleRate, 1, chunk.length);
  }
}

export function buildGreetingV3RenderConfig(input: {
  apiKey: string;
  voiceId: string;
  encoding?: string;
  baseURL?: string;
  voiceSettings?: ElevenLabsHttpV3Config['voiceSettings'];
}): ElevenLabsHttpV3Config {
  const encoding = input.encoding?.trim() || 'pcm_24000';
  const sampleRateMatch = encoding.match(/(\d+)$/);
  return {
    apiKey: input.apiKey,
    voiceId: input.voiceId,
    model: GREETING_V3_MODEL,
    encoding,
    sampleRate: sampleRateMatch ? Number.parseInt(sampleRateMatch[1]!, 10) : 24000,
    baseURL: (input.baseURL ?? 'https://api.elevenlabs.io/v1').replace(/\/$/, ''),
    ...(input.voiceSettings ? { voiceSettings: input.voiceSettings } : {}),
  };
}

/** Render greeting for cache — uses comma-flow prep, no v3 audio tags. */
export async function renderGreetingPcmForCache(
  config: ElevenLabsHttpV3Config,
  greetingText: string,
): Promise<Uint8Array> {
  const spoken = prepareGreetingForTts(greetingText);
  return renderTextToPcmWithV3(config, spoken);
}

export function splitGreetingSentences(text: string): string[] {
  const tokenizer = new tokenize.basic.SentenceTokenizer();
  return tokenizer
    .tokenize(text)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
