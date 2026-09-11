import type { CallTestProfile } from './test_profile.js';

/** Cartesia "Siobhan - Warm Welcomer" — approachable Irish female for voice agents. */
export const CARTESIA_SIOBHAN_VOICE_ID = 'd79d2b77-9192-4e10-9407-5d43ca034803';

/** Demo line ElevenLabs Irish female — override via ELEVEN_VOICE_ID. */
export const DEFAULT_ELEVEN_VOICE_ID = 'odyUrTN5HMVKujvVAgWW';

/** Default ElevenLabs model for live calls and cached greetings. */
export const DEFAULT_ELEVEN_TTS_MODEL = 'eleven_v3';

export type TtsProviderKind = 'elevenlabs' | 'cartesia-inference';

export type ResolvedTtsConfig =
  | {
      provider: 'elevenlabs';
      model: string;
      voiceId: string;
      label: string;
    }
  | {
      provider: 'cartesia-inference';
      model: string;
      voiceId: string;
      language: string;
      label: string;
    };

export function isCartesiaInferenceTtsModel(model: string | null | undefined): boolean {
  return Boolean(model?.trim().toLowerCase().startsWith('cartesia/'));
}

function resolveElevenVoiceId(input: {
  testProfile: CallTestProfile | null;
  orgVoiceId: string | null;
  envProvider: string | undefined;
}): string {
  const envVoice = process.env.ELEVEN_VOICE_ID?.trim();
  // When env explicitly selects Eleven, ELEVEN_VOICE_ID wins — avoids Cartesia UUID on profile.
  if (input.envProvider === 'elevenlabs' && envVoice) {
    return envVoice;
  }
  return (
    input.testProfile?.voice_id?.trim() ||
    input.orgVoiceId ||
    envVoice ||
    DEFAULT_ELEVEN_VOICE_ID
  );
}

function resolveElevenModel(profileModel: string | null | undefined): string {
  const envElevenModel = process.env.ELEVEN_TTS_MODEL?.trim();
  if (envElevenModel) return envElevenModel;
  if (profileModel && !isCartesiaInferenceTtsModel(profileModel)) return profileModel;
  return DEFAULT_ELEVEN_TTS_MODEL;
}

function resolveCartesiaConfig(input: {
  testProfile: CallTestProfile | null;
  profileModel: string | null | undefined;
  envInferenceModel: string | undefined;
}): Extract<ResolvedTtsConfig, { provider: 'cartesia-inference' }> {
  const profileModel = input.profileModel;
  const cartesiaModel =
    (profileModel && isCartesiaInferenceTtsModel(profileModel) && profileModel) ||
    (isCartesiaInferenceTtsModel(input.envInferenceModel) && input.envInferenceModel) ||
    'cartesia/sonic-3.6';

  const voiceId =
    (profileModel && isCartesiaInferenceTtsModel(profileModel)
      ? input.testProfile?.voice_id?.trim()
      : undefined) ||
    process.env.LIVEKIT_INFERENCE_TTS_VOICE?.trim() ||
    CARTESIA_SIOBHAN_VOICE_ID;

  return {
    provider: 'cartesia-inference',
    model: cartesiaModel,
    voiceId,
    language: process.env.LIVEKIT_INFERENCE_TTS_LANGUAGE?.trim() || 'en',
    label: `${cartesiaModel}:${voiceId}`,
  };
}

export function resolveTtsConfig(input: {
  testProfile: CallTestProfile | null;
  orgVoiceId: string | null;
}): ResolvedTtsConfig {
  const profileModel = input.testProfile?.tts_model?.trim();
  const envInferenceModel = process.env.LIVEKIT_INFERENCE_TTS_MODEL?.trim();
  const envProvider = process.env.CARA_TTS_PROVIDER?.trim().toLowerCase();

  const elevenVoiceId = resolveElevenVoiceId({
    testProfile: input.testProfile,
    orgVoiceId: input.orgVoiceId,
    envProvider,
  });

  // CARA_TTS_PROVIDER=elevenlabs must win over a stale Cartesia profile row (silence bug).
  if (envProvider === 'elevenlabs') {
    const model = resolveElevenModel(profileModel);
    return {
      provider: 'elevenlabs',
      model,
      voiceId: elevenVoiceId,
      label: `elevenlabs:${model}:${elevenVoiceId}`,
    };
  }

  // CARA_TTS_PROVIDER=cartesia-inference must win over a stale Eleven profile row.
  if (envProvider === 'cartesia-inference') {
    return resolveCartesiaConfig({
      testProfile: input.testProfile,
      profileModel,
      envInferenceModel,
    });
  }

  if (profileModel && isCartesiaInferenceTtsModel(profileModel)) {
    return resolveCartesiaConfig({
      testProfile: input.testProfile,
      profileModel,
      envInferenceModel,
    });
  }

  if (profileModel && !isCartesiaInferenceTtsModel(profileModel)) {
    const model = resolveElevenModel(profileModel);
    return {
      provider: 'elevenlabs',
      model,
      voiceId: elevenVoiceId,
      label: `elevenlabs:${model}:${elevenVoiceId}`,
    };
  }

  return resolveCartesiaConfig({
    testProfile: input.testProfile,
    profileModel,
    envInferenceModel,
  });
}
