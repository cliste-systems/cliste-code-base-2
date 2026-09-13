import type { CallTestProfile } from './test_profile.js';

/** Cartesia "Siobhan - Warm Welcomer" — approachable Irish female for voice agents. */
export const CARTESIA_SIOBHAN_VOICE_ID = 'd79d2b77-9192-4e10-9407-5d43ca034803';

export type ResolvedTtsConfig = {
  model: string;
  voiceId: string;
  language: string;
  label: string;
};

/** Cartesia inference voices are UUIDs — ignore stale voice ids from other providers. */
export function isCartesiaVoiceId(voiceId: string | null | undefined): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    voiceId?.trim() ?? '',
  );
}

function resolveCartesiaVoiceId(input: {
  testProfile: CallTestProfile | null;
  orgVoiceId: string | null;
  profileUsesCartesiaModel: boolean;
}): string {
  const profileVoice = input.testProfile?.voice_id?.trim();
  if (input.profileUsesCartesiaModel && profileVoice && isCartesiaVoiceId(profileVoice)) {
    return profileVoice;
  }
  const orgVoice = input.orgVoiceId?.trim();
  if (orgVoice && isCartesiaVoiceId(orgVoice)) {
    return orgVoice;
  }
  return process.env.LIVEKIT_INFERENCE_TTS_VOICE?.trim() || CARTESIA_SIOBHAN_VOICE_ID;
}

export function resolveTtsConfig(input: {
  testProfile: CallTestProfile | null;
  orgVoiceId: string | null;
}): ResolvedTtsConfig {
  const profileModel = input.testProfile?.tts_model?.trim();
  const envInferenceModel = process.env.LIVEKIT_INFERENCE_TTS_MODEL?.trim();
  const cartesiaModel =
    (profileModel && profileModel.toLowerCase().startsWith('cartesia/') && profileModel) ||
    (envInferenceModel && envInferenceModel.toLowerCase().startsWith('cartesia/') && envInferenceModel) ||
    'cartesia/sonic-3.6';

  const voiceId = resolveCartesiaVoiceId({
    testProfile: input.testProfile,
    orgVoiceId: input.orgVoiceId,
    profileUsesCartesiaModel: Boolean(profileModel && profileModel.toLowerCase().startsWith('cartesia/')),
  });

  return {
    model: cartesiaModel,
    voiceId,
    language: process.env.LIVEKIT_INFERENCE_TTS_LANGUAGE?.trim() || 'en',
    label: `${cartesiaModel}:${voiceId}`,
  };
}
