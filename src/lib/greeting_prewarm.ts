import { ensureGreetingPcmCached } from './greeting_audio_cache.js';
import { resolveElevenVoiceSettings } from './call_participant.js';
import { getOrgForCall, resolveOrgVoiceId } from './supabase.js';
import { resolveTtsConfig } from './tts_config.js';

const DEFAULT_PREWARM_TARGETS = [
  { slug: 'hello-cara-demo', phone: '+353749389378' },
  { phone: '+353749759508' },
] as const;

async function prewarmGreetingForTarget(input: {
  slug?: string;
  phone: string;
  apiKey: string;
}): Promise<void> {
  const org = await getOrgForCall({
    ...(input.slug ? { slug: input.slug } : {}),
    phone: input.phone,
  });
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
    apiKey: input.apiKey,
    voiceId: tts.voiceId,
    encoding,
    baseURL,
    voiceSettings,
  });

  console.info('[agent] greeting_prewarm_complete', {
    orgId: org.id,
    slug: org.slug,
    phone: input.phone,
    bytes: pcm.byteLength,
  });
}

/** Warm Eleven greeting PCM at worker boot so demo + retail lines speak immediately. */
export async function prewarmConfiguredGreetingCaches(): Promise<void> {
  const apiKey =
    process.env.ELEVENLABS_API_KEY?.trim() || process.env.ELEVEN_API_KEY?.trim();
  if (!apiKey) return;

  const extraPhones = (process.env.CARA_GREETING_PREWARM_PHONES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((phone) => ({ phone }));

  const slug = process.env.CARA_GREETING_PREWARM_SLUG?.trim();
  const phone = process.env.CARA_GREETING_PREWARM_PHONE?.trim();
  const envTarget =
    slug || phone
      ? [{ ...(slug ? { slug } : {}), phone: phone || '+353749389378' }]
      : [];

  const targets = [...DEFAULT_PREWARM_TARGETS, ...envTarget, ...extraPhones];
  const seen = new Set<string>();

  for (const target of targets) {
    const key = `${target.slug ?? ''}:${target.phone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await prewarmGreetingForTarget({
        slug: 'slug' in target ? target.slug : undefined,
        phone: target.phone,
        apiKey,
      });
    } catch (e) {
      console.warn('[agent] greeting_prewarm_target_failed', {
        phone: target.phone,
        slug: 'slug' in target ? target.slug : undefined,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
