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
    `&output_format=${encodeURIComponent(config.encoding)}`;
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

    const synthesizeSentence = async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed || this.abortController.signal.aborted) {
        return;
      }

      const voiceSettings = this.#config.voiceSettings
        ? stripUndefined(this.#config.voiceSettings)
        : undefined;

      const response = await fetch(buildHttpStreamUrl(this.#config), {
        method: 'POST',
        headers: {
          [AUTHORIZATION_HEADER]: this.#config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: trimmed,
          model_id: this.#config.model,
          voice_settings: voiceSettings,
        }),
        signal: this.abortSignal,
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (this.abortController.signal.aborted) {
          break;
        }

        for (const frame of bstream.write(value.buffer)) {
          sendLastFrame(false);
          lastFrame = frame;
        }
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
      for await (const data of sentTokenizerStream) {
        if (this.abortController.signal.aborted) {
          break;
        }
        await synthesizeSentence(data.token);
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

export function createElevenLabsTts(opts: elevenlabs.TTSOptions = {}): ElevenLabsQualityTts {
  return new ElevenLabsQualityTts(opts);
}
