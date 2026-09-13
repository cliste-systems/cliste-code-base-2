/**
 * Smoke-test LiveKit, Supabase, voice webhooks, and Cartesia TTS config.
 * Run: npm run verify
 */
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { RoomServiceClient } from 'livekit-server-sdk';
import { resolveTtsConfig } from '../src/lib/tts_config.js';
import { twilioSmsConfigured } from '../src/lib/twilio_sms.js';
import { ie1SmsConfigured } from '../src/lib/twilio_ie_messaging.js';
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
    const base = process.env.CLISTE_APP_URL?.trim().replace(/\/$/, '') ?? '';
    try {
      const res = await fetch(`${base}/api/voice/send-sms`, { method: 'POST' });
      if (res.status === 404) {
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('text/html')) {
          const msg =
            'Voice webhook /api/voice/send-sms returns HTML 404 — deploy code-base-1 or use direct Twilio on worker';
          if (twilioSmsConfigured()) {
            console.warn(`⚠ ${msg} (direct Twilio path available)`);
          } else {
            failures.push(msg);
            console.error('✗ Voice webhook /api/voice/send-sms missing on CLISTE_APP_URL (HTML 404)');
          }
        }
      } else {
        console.log(`✓ Voice webhook /api/voice/send-sms reachable (HTTP ${res.status})`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`Voice webhook probe: ${msg}`);
      console.error('✗ Voice webhook probe:', msg);
    }
  } else {
    const msg = 'Voice webhooks not configured (CLISTE_APP_URL + CLISTE_VOICE_WEBHOOK_SECRET)';
    failures.push(msg);
    console.error('✗', msg);
  }

  if (twilioSmsConfigured()) {
    console.log('✓ Twilio SMS: credentials + from number configured (direct worker path)');
    if (ie1SmsConfigured()) {
      console.log('✓ Twilio IE1: regional credentials set (Irish +353 SMS from org DID)');
    } else {
      failures.push(
        'TWILIO_IE1_AUTH_TOKEN (or TWILIO_IE1_API_KEY/SECRET) missing — Irish caller SMS will fail until IE1 credentials are set in Twilio Console',
      );
      console.error(
        '✗ Twilio IE1 credentials missing — caller-facing SMS from +353 numbers requires IE1 auth',
      );
    }
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? '';
      const token = process.env.TWILIO_AUTH_TOKEN?.trim() ?? '';
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      console.log('✓ Twilio API: account credentials accepted');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`Twilio API: ${msg}`);
      console.error('✗ Twilio API:', msg);
    }
  } else {
    console.warn('⚠ Twilio SMS not configured locally — worker will fall back to voice webhook');
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
    const tts = resolveTtsConfig({ testProfile: null, orgVoiceId: null });
    if (!tts.model.startsWith('cartesia/')) {
      throw new Error(`Expected cartesia inference model, got ${tts.model}`);
    }
    if (!tts.voiceId) {
      throw new Error('Cartesia voice id missing');
    }
    console.log(`✓ TTS: LiveKit Inference Cartesia (${tts.label})`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`TTS: ${msg}`);
    console.error('✗ TTS:', msg);
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
