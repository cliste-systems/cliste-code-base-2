/**
 * Smoke-test LiveKit, Supabase, voice webhooks, and ElevenLabs TTS (required).
 * Run: npm run verify
 */
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { RoomServiceClient } from 'livekit-server-sdk';
import { isElevenV3Model } from '../src/lib/elevenlabs-v3-http-tts.js';
import { voiceWebhooksConfigured } from '../src/lib/voice_api.js';

function httpsHost(): string {
  const u = process.env.LIVEKIT_URL;
  if (!u) {
    throw new Error('Missing LIVEKIT_URL');
  }
  return u.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

async function main(): Promise<void> {
  const failures: string[] = [];

  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
    }
    const supabase = createClient(url, key);
    const { error } = await supabase.from('organizations').select('id').limit(1);
    if (error) throw error;
    console.log('✓ Supabase: connected (organizations readable)');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`Supabase: ${msg}`);
    console.error('✗ Supabase:', msg);
  }

  if (voiceWebhooksConfigured()) {
    console.log('✓ Voice webhooks: CLISTE_APP_URL + CLISTE_VOICE_WEBHOOK_SECRET set');
  } else {
    const msg = 'Voice webhooks not configured (CLISTE_APP_URL + CLISTE_VOICE_WEBHOOK_SECRET)';
    failures.push(msg);
    console.error('✗', msg);
  }

  try {
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!key || !secret) {
      throw new Error('LIVEKIT_API_KEY or LIVEKIT_API_SECRET missing');
    }
    const rooms = new RoomServiceClient(httpsHost(), key, secret);
    await rooms.listRooms();
    console.log('✓ LiveKit: API accepted (listRooms ok)');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`LiveKit: ${msg}`);
    console.error('✗ LiveKit:', msg);
  }

  try {
    const apiKey =
      process.env.ELEVEN_API_KEY?.trim() || process.env.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('ELEVENLABS_API_KEY or ELEVEN_API_KEY missing (ElevenLabs-only TTS)');
    }
    const res = await fetch('https://api.elevenlabs.io/v1/voices?page_size=1', {
      headers: { 'xi-api-key': apiKey },
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`${res.status} ${t.slice(0, 200)}`);
    }
    const model = process.env.ELEVEN_TTS_MODEL?.trim() || 'eleven_flash_v2_5';
    const voice = process.env.ELEVEN_VOICE_ID?.trim() || 'C92s6vssSLlabgIln1iY';
    const encoding = process.env.ELEVEN_TTS_ENCODING?.trim() || 'pcm_24000';
    const baseUrl =
      (process.env.ELEVENLABS_BASE_URL?.trim() || 'https://api.elevenlabs.io/v1').replace(
        /\/$/,
        '',
      );

    if (isElevenV3Model(model)) {
      const streamUrl =
        `${baseUrl}/text-to-speech/${voice}/stream` +
        `?model_id=${encodeURIComponent(model)}` +
        `&output_format=${encodeURIComponent(encoding)}`;
      const streamRes = await fetch(streamUrl, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'Hello', model_id: model }),
      });
      if (!streamRes.ok) {
        const t = await streamRes.text();
        throw new Error(`v3 HTTP stream ${streamRes.status}: ${t.slice(0, 200)}`);
      }
      console.log(`✓ ElevenLabs: v3 HTTP stream OK (${model}, ${encoding})`);
    } else {
      const wsUrl =
        `wss://api.elevenlabs.io/v1/text-to-speech/${voice}/multi-stream-input` +
        `?model_id=${encodeURIComponent(model)}&output_format=${encodeURIComponent(encoding)}` +
        '&enable_ssml_parsing=false&enable_logging=true&inactivity_timeout=60&apply_text_normalization=auto';
      const ws = await import('ws').then((m) => m.default);
      await new Promise<void>((resolve, reject) => {
        const socket = new ws(wsUrl, { headers: { 'xi-api-key': apiKey } });
        const timer = setTimeout(() => {
          socket.terminate();
          reject(new Error(`WebSocket open timed out (${model})`));
        }, 8000);
        socket.once('open', () => {
          clearTimeout(timer);
          socket.close();
          resolve();
        });
        socket.once('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
          clearTimeout(timer);
          reject(new Error(`WebSocket rejected model ${model}: HTTP ${res.statusCode}`));
        });
        socket.once('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      console.log(`✓ ElevenLabs: WebSocket OK (${model}, ${encoding})`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`ElevenLabs: ${msg}`);
    console.error('✗ ElevenLabs:', msg);
  }

  if (failures.length > 0) {
    console.error('\nFailed:', failures.length);
    process.exit(1);
  }
  console.log('\nAll integration checks passed. Run: npm run dev');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
