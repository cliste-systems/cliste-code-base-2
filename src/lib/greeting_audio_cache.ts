import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AudioByteStream, tokenize } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';

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

/** PCM int16 mono → LiveKit AudioFrame stream (same framing as TTS / audioFramesFromFile). */
export function pcmToAudioFrameStream(
  pcm: Uint8Array,
  sampleRate: number,
): ReadableStream<AudioFrame> {
  const byteStream = new AudioByteStream(sampleRate, 1);
  const frames = [...byteStream.write(pcm), ...byteStream.flush()];
  return ReadableStream.from(frames);
}

/** Load cached greeting PCM or render via Eleven v3 and store for the next call. */
export async function ensureGreetingPcmCached(input: {
  orgId: string;
  greetingText: string;
  apiKey: string;
  voiceId: string;
  encoding?: string;
  baseURL?: string;
  voiceSettings?: ElevenLabsHttpV3Config['voiceSettings'];
}): Promise<Uint8Array> {
  const cacheKey = greetingAudioCacheKey(input.orgId, input.greetingText, input.voiceId);
  const existing = await loadCachedGreetingPcm(cacheKey);
  if (existing?.byteLength) return existing;

  const config = buildGreetingV3RenderConfig({
    apiKey: input.apiKey,
    voiceId: input.voiceId,
    ...(input.encoding ? { encoding: input.encoding } : {}),
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
    ...(input.voiceSettings ? { voiceSettings: input.voiceSettings } : {}),
  });
  const pcm = await renderGreetingPcmForCache(config, input.greetingText);
  await storeCachedGreetingPcm(cacheKey, pcm);
  return pcm;
}

export function pcmSampleRateFromEncoding(encoding: string | undefined): number {
  const sampleRateMatch = (encoding?.trim() || 'pcm_24000').match(/(\d+)$/);
  return sampleRateMatch ? Number.parseInt(sampleRateMatch[1]!, 10) : 24000;
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
