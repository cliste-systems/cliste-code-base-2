import { resolveElevenVoiceSettings, voiceSettingsCacheFingerprint } from './call_participant.js';
import { ensureGreetingPcmCached } from './greeting_audio_cache.js';
import { getOrgForCall, resolveOrgVoiceId } from './supabase.js';
import { resolveTtsConfig } from './tts_config.js';

/** Warm v3 greeting PCM at worker boot so demo calls speak immediately. */
export async function prewarmConfiguredGreetingCaches(): Promise<void> {
  if (process.env.CARA_TTS_PROVIDER?.trim().toLowerCase() !== 'elevenlabs') return;

  const apiKey =
    process.env.ELEVENLABS_API_KEY?.trim() || process.env.ELEVEN_API_KEY?.trim();
  if (!apiKey) return;

  const slug = process.env.CARA_GREETING_PREWARM_SLUG?.trim() || 'hello-cara-demo';
  const phone =
    process.env.CARA_GREETING_PREWARM_PHONE?.trim() ||
    process.env.DEFAULT_ORG_PHONE?.trim() ||
    '+353749389378';

  const org = await getOrgForCall({ slug, phone });
  const greetingText = org?.greeting?.trim();
  if (!org || !greetingText) return;

  const tts = resolveTtsConfig({
    testProfile: null,
    orgVoiceId: resolveOrgVoiceId(org),
  });
  if (tts.provider !== 'elevenlabs') return;

  const voiceSettings = resolveElevenVoiceSettings();
  const encoding = process.env.ELEVEN_TTS_ENCODING?.trim() || 'pcm_24000';
  const baseURL =
    process.env.ELEVENLABS_BASE_URL?.trim() || 'https://api.elevenlabs.io/v1';

  const pcm = await ensureGreetingPcmCached({
    orgId: org.id,
    greetingText,
    apiKey,
    voiceId: tts.voiceId,
    encoding,
    baseURL,
    voiceSettings,
  });

  console.info('[agent] greeting_prewarm_complete', {
    orgId: org.id,
    slug: org.slug,
    bytes: pcm.byteLength,
  });
}
