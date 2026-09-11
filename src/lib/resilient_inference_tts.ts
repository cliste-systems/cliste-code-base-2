import { inference, tts as lkTts } from '@livekit/agents';
import type * as elevenlabs from '@livekit/agents-plugin-elevenlabs';

import { createElevenLabsTts } from './elevenlabs-v3-http-tts.js';

export type BuildResilientSessionTtsInput = {
  useCartesiaInference: boolean;
  cartesia: {
    model: string;
    voiceId: string;
    language: string;
  };
  eleven: {
    apiKey: string;
    voiceId: string;
    model: string;
    encoding: string;
    baseURL: string;
    streamingLatency: number;
    voiceSettings?: elevenlabs.VoiceSettings;
  } | null;
};

export function shouldWrapCartesiaWithElevenFallback(
  useCartesiaInference: boolean,
  elevenApiKey: string | null | undefined,
): boolean {
  return useCartesiaInference && Boolean(elevenApiKey?.trim());
}

/** Cartesia primary with optional Eleven HTTP fallback when inference TTS hits 429. */
export function buildResilientSessionTts(input: BuildResilientSessionTtsInput) {
  if (!input.useCartesiaInference) {
    if (!input.eleven?.apiKey) {
      throw new Error('ElevenLabs API key required when not using Cartesia inference TTS');
    }
    return createElevenLabsTts({
      apiKey: input.eleven.apiKey,
      voiceId: input.eleven.voiceId,
      model: input.eleven.model as elevenlabs.TTSModels,
      encoding: input.eleven.encoding as elevenlabs.TTSEncoding,
      baseURL: input.eleven.baseURL,
      streamingLatency: input.eleven.streamingLatency,
      voiceSettings: input.eleven.voiceSettings,
    });
  }

  const primary = new inference.TTS({
    model: input.cartesia.model,
    voice: input.cartesia.voiceId,
    language: input.cartesia.language,
  });

  const eleven = input.eleven;
  if (!shouldWrapCartesiaWithElevenFallback(true, eleven?.apiKey)) {
    return primary;
  }

  const fallback = createElevenLabsTts({
    apiKey: eleven!.apiKey,
    voiceId: eleven!.voiceId,
    model: eleven!.model as elevenlabs.TTSModels,
    encoding: eleven!.encoding as elevenlabs.TTSEncoding,
    baseURL: eleven!.baseURL,
    streamingLatency: eleven!.streamingLatency,
    voiceSettings: eleven!.voiceSettings,
  });

  return new lkTts.FallbackAdapter({
    ttsInstances: [primary, fallback],
    maxRetryPerTTS:
      Number.parseInt(process.env.LIVEKIT_TTS_MAX_RETRY_PER_INSTANCE ?? '2', 10) || 2,
    recoveryDelayMs:
      Number.parseInt(process.env.LIVEKIT_TTS_RETRY_INTERVAL_MS ?? '2000', 10) || 2000,
  });
}
