/**
 * ElevenLabs TTS with HTTP /stream fallback for eleven_v3.
 * v3 is rejected (403) on the WebSocket multi-stream path the stock plugin uses.
 */
import {
  APIConnectionError,
  APIError,
  APIStatusError,
  AudioByteStream,
  type APIConnectOptions,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';

const AUTHORIZATION_HEADER = 'xi-api-key';
const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1';

export function isElevenV3Model(model: string): boolean {
  return model === 'eleven_v3' || model.startsWith('eleven_v3_');
}

export type ElevenLabsHttpV3Config = {
  apiKey: string;
  voiceId: string;
  model: string;
  encoding: string;
  sampleRate: number;
  baseURL: string;
  voiceSettings?: elevenlabs.VoiceSettings;
  streamingLatency?: number;
};

function sampleRateFromEncoding(encoding: string): number {
  const match = encoding.match(/(\d+)$/);
  return match ? Number.parseInt(match[1]!, 10) : 22050;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

function buildHttpStreamUrl(config: ElevenLabsHttpV3Config): string {
  let url =
    `${config.baseURL}/text-to-speech/${config.voiceId}/stream` +
    `?model_id=${encodeURIComponent(config.model)}` +
    `&output_format=${encodeURIComponent(config.encoding)}` +
    `&apply_text_normalization=auto`;
  if (config.streamingLatency !== undefined) {
    url += `&optimize_streaming_latency=${config.streamingLatency}`;
  }
  return url;
}

export function resolveElevenLabsHttpV3Config(
  opts: elevenlabs.TTSOptions,
): ElevenLabsHttpV3Config | null {
  const model = String(opts.model ?? 'eleven_turbo_v2_5');
  if (!isElevenV3Model(model)) {
    return null;
  }
  const encoding = opts.encoding ?? 'pcm_24000';
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const apiKey =
    opts.apiKey?.trim() ||
    process.env.ELEVEN_API_KEY?.trim() ||
    process.env.ELEVENLABS_API_KEY?.trim() ||
    '';
  const voiceId = opts.voiceId?.trim() || '';
  const config: ElevenLabsHttpV3Config = {
    apiKey,
    voiceId,
    model,
    encoding,
    sampleRate: sampleRateFromEncoding(encoding),
    baseURL,
  };
  if (opts.voiceSettings !== undefined) {
    config.voiceSettings = opts.voiceSettings;
  }
  if (opts.streamingLatency !== undefined) {
    config.streamingLatency = opts.streamingLatency;
  }
  return config;
}

export type V3SentenceContext = {
  previousText?: string;
  nextText?: string;
};

export async function fetchV3SentencePcm(
  config: ElevenLabsHttpV3Config,
  text: string,
  context?: V3SentenceContext,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const trimmed = text.trim();
  if (!trimmed) {
    return new Uint8Array();
  }

  const voiceSettings = config.voiceSettings
    ? stripUndefined(config.voiceSettings)
    : undefined;

  const body: Record<string, unknown> = {
    text: trimmed,
    model_id: config.model,
    voice_settings: voiceSettings,
  };
  if (context?.previousText?.trim()) {
    body.previous_text = context.previousText.trim();
  }
  if (context?.nextText?.trim()) {
    body.next_text = context.nextText.trim();
  }

  const response = await fetch(buildHttpStreamUrl(config), {
    method: 'POST',
    headers: {
      [AUTHORIZATION_HEADER]: config.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new APIStatusError({
      message: `ElevenLabs v3 HTTP stream error: ${errorText}`,
      options: { statusCode: response.status },
    });
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('audio/')) {
    const content = await response.text();
    throw new APIError(`ElevenLabs v3 returned non-audio data: ${content}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new APIError('ElevenLabs v3 stream has no response body');
  }

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value?.byteLength) {
      chunks.push(value);
    }
  }

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Offline render of full text via v3 HTTP (sentence continuity). */
export async function renderTextToPcmWithV3(
  config: ElevenLabsHttpV3Config,
  text: string,
): Promise<Uint8Array> {
  const tokenizer = new tokenize.basic.SentenceTokenizer();
  const sentences = tokenizer
    .tokenize(text)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length === 0) {
    return new Uint8Array();
  }

  const pcmParts: Uint8Array[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]!;
    const ctx: V3SentenceContext = {};
    const prev = i > 0 ? sentences[i - 1] : undefined;
    const next = i < sentences.length - 1 ? sentences[i + 1] : undefined;
    if (prev) ctx.previousText = prev;
    if (next) ctx.nextText = next;
    const pcm = await fetchV3SentencePcm(config, sentence, ctx);
    if (pcm.byteLength > 0) {
      pcmParts.push(pcm);
    }
  }

  const total = pcmParts.reduce((n, p) => n + p.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of pcmParts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

class V3HttpSynthesizeStream extends tts.SynthesizeStream {
  #config: ElevenLabsHttpV3Config;
  label = 'elevenlabs.v3-http.SynthesizeStream';

  constructor(
    parent: ElevenLabsQualityTts,
    config: ElevenLabsHttpV3Config,
    connOptions?: APIConnectOptions,
  ) {
    super(parent, connOptions);
    this.#config = config;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const segmentId = shortuuid();
    const bstream = new AudioByteStream(this.#config.sampleRate, 1);
    const sentTokenizerStream = new tokenize.basic.SentenceTokenizer().stream();
    let lastFrame: AudioFrame | undefined;

    const sendLastFrame = (final: boolean) => {
      if (lastFrame) {
        this.queue.put({ requestId, segmentId, frame: lastFrame, final });
        lastFrame = undefined;
      } else if (final) {
        // Segment ended with no audio (e.g. whitespace-only sentence).
      }
    };

    const synthesizeSentence = async (
      text: string,
      context?: V3SentenceContext,
    ): Promise<void> => {
      const pcm = await fetchV3SentencePcm(
        this.#config,
        text,
        context,
        this.abortSignal,
      );
      if (!pcm.byteLength || this.abortController.signal.aborted) {
        return;
      }

      for (const frame of bstream.write(pcm.buffer)) {
        sendLastFrame(false);
        lastFrame = frame;
      }
    };

    const inputTask = async (): Promise<void> => {
      for await (const data of this.input) {
        if (this.abortController.signal.aborted) {
          break;
        }
        if (data === tts.SynthesizeStream.FLUSH_SENTINEL) {
          sentTokenizerStream.flush();
          continue;
        }
        sentTokenizerStream.pushText(data);
      }
      sentTokenizerStream.endInput();
    };

    const sentenceTask = async (): Promise<void> => {
      const sentences: string[] = [];
      for await (const data of sentTokenizerStream) {
        if (this.abortController.signal.aborted) {
          break;
        }
        const trimmed = data.token.trim();
        if (trimmed) {
          sentences.push(trimmed);
        }
      }

      for (let i = 0; i < sentences.length; i++) {
        if (this.abortController.signal.aborted) {
          break;
        }
        const sentence = sentences[i]!;
        const ctx: V3SentenceContext = {};
        const prev = i > 0 ? sentences[i - 1] : undefined;
        const next = i < sentences.length - 1 ? sentences[i + 1] : undefined;
        if (prev) ctx.previousText = prev;
        if (next) ctx.nextText = next;
        await synthesizeSentence(sentence, ctx);
      }
    };

    try {
      await Promise.all([inputTask(), sentenceTask()]);

      for (const frame of bstream.flush()) {
        sendLastFrame(false);
        lastFrame = frame;
      }
      sendLastFrame(true);
    } catch (e) {
      if (e instanceof APIError) {
        throw e;
      }
      if (e instanceof Error && e.name === 'AbortError') {
        return;
      }
      throw new APIConnectionError({
        message: `ElevenLabs v3 HTTP stream failed: ${e instanceof Error ? e.message : e}`,
      });
    }
  }
}

/** ElevenLabs TTS — routes eleven_v3 through HTTP /stream instead of WebSocket. */
export class ElevenLabsQualityTts extends elevenlabs.TTS {
  readonly httpV3Config: ElevenLabsHttpV3Config | null;

  constructor(opts: elevenlabs.TTSOptions = {}) {
    super(opts);
    this.httpV3Config = resolveElevenLabsHttpV3Config(opts);
  }

  override stream(options?: {
    connOptions?: APIConnectOptions;
  }): ReturnType<elevenlabs.TTS['stream']> {
    if (this.httpV3Config) {
      return new V3HttpSynthesizeStream(
        this,
        this.httpV3Config,
        options?.connOptions,
      ) as unknown as ReturnType<elevenlabs.TTS['stream']>;
    }
    return super.stream(options);
  }
}

export function resolvePronunciationDictionaryLocators():
  | Array<{ pronunciation_dictionary_id: string; version_id?: string }>
  | undefined {
  const dictId = process.env.ELEVEN_PRONUNCIATION_DICTIONARY_ID?.trim();
  if (!dictId) {
    return undefined;
  }
  const versionId = process.env.ELEVEN_PRONUNCIATION_DICTIONARY_VERSION_ID?.trim();
  return versionId
    ? [{ pronunciation_dictionary_id: dictId, version_id: versionId }]
    : [{ pronunciation_dictionary_id: dictId }];
}

export function createElevenLabsTts(opts: elevenlabs.TTSOptions = {}): ElevenLabsQualityTts {
  const locators = resolvePronunciationDictionaryLocators();
  const autoModeRaw = process.env.ELEVEN_TTS_AUTO_MODE?.trim().toLowerCase();
  const autoMode = autoModeRaw === 'true' || autoModeRaw === '1';
  const merged: elevenlabs.TTSOptions = {
    ...opts,
    autoMode,
    ...(locators
      ? ({ pronunciationDictionaryLocators: locators } as elevenlabs.TTSOptions)
      : {}),
  };
  return new ElevenLabsQualityTts(merged);
}
