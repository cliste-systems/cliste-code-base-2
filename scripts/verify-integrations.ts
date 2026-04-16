/**
 * Smoke-test LiveKit, Supabase, Twilio, and TTS credentials (per SALON_TTS_PROVIDER).
 * Run: npx tsx scripts/verify-integrations.ts
 */
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { RoomServiceClient } from 'livekit-server-sdk';

function httpsHost(): string {
  const u = process.env.LIVEKIT_URL;
  if (!u) {
    throw new Error('Missing LIVEKIT_URL');
  }
  return u.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

/** Mirrors `src/agent.ts` TTS selection for smoke tests. */
function resolveTtsModeForVerify(): 'openai' | 'elevenlabs' | 'livekit' {
  const raw = process.env.SALON_TTS_PROVIDER?.trim().toLowerCase() || '';
  const eleven =
    process.env.ELEVEN_API_KEY?.trim() || process.env.ELEVENLABS_API_KEY?.trim() || '';
  const oai = process.env.OPENAI_API_KEY?.trim() || '';
  if (raw === 'livekit') {
    return 'livekit';
  }
  if (raw === 'openai') {
    return 'openai';
  }
  if (raw === 'elevenlabs') {
    return 'elevenlabs';
  }
  if (eleven) {
    return 'elevenlabs';
  }
  if (oai) {
    return 'openai';
  }
  return 'livekit';
}

async function main(): Promise<void> {
  const failures: string[] = [];

  // Supabase
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
    }
    const supabase = createClient(url, key);
    const { error } = await supabase.from('organizations').select('id').limit(1);
    if (error) {
      throw error;
    }
    console.log('✓ Supabase: connected (organizations readable)');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`Supabase: ${msg}`);
    console.error('✗ Supabase:', msg);
  }

  // Twilio
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new Error('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing');
    }
    const client = twilio(sid, token);
    const account = await client.api.accounts(sid).fetch();
    console.log('✓ Twilio: account', account.status, `(${account.friendlyName ?? sid})`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`Twilio: ${msg}`);
    console.error('✗ Twilio:', msg);
  }

  // LiveKit API (same keys as the worker)
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

  // TTS (LiveKit Inference vs ElevenLabs vs OpenAI — same rules as the worker)
  const ttsMode = resolveTtsModeForVerify();
  if (ttsMode === 'livekit') {
    const m = process.env.LIVEKIT_INFERENCE_TTS_MODEL?.trim() || 'cartesia/sonic-turbo';
    const v = process.env.LIVEKIT_INFERENCE_TTS_VOICE?.trim() || '(default voice id)';
    console.log('✓ LiveKit Inference TTS: worker will use', m, '+', v, '(LIVEKIT_API_KEY / SECRET)');
  } else if (ttsMode === 'openai') {
    try {
      const key = process.env.OPENAI_API_KEY?.trim();
      if (!key) {
        throw new Error('OPENAI_API_KEY missing (SALON_TTS_PROVIDER=openai)');
      }
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`${res.status} ${t.slice(0, 200)}`);
      }
      console.log('✓ OpenAI: API key accepted (TTS uses OPENAI_TTS_* / default gpt-4o-mini-tts + coral)');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`OpenAI TTS: ${msg}`);
      console.error('✗ OpenAI TTS:', msg);
    }
  } else if (ttsMode === 'elevenlabs') {
    try {
      const apiKey =
        process.env.ELEVEN_API_KEY?.trim() ||
        process.env.ELEVENLABS_API_KEY?.trim();
      if (!apiKey) {
        throw new Error('ELEVENLABS_API_KEY or ELEVEN_API_KEY missing');
      }
      const res = await fetch('https://api.elevenlabs.io/v1/voices?page_size=1', {
        headers: { 'xi-api-key': apiKey },
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`${res.status} ${t.slice(0, 200)}`);
      }
      console.log('✓ ElevenLabs: API key valid (voices/TTS)');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`ElevenLabs: ${msg}`);
      console.error('✗ ElevenLabs:', msg);
    }
  }

  // Salon routing sanity (optional)
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
      const supabase = createClient(url, key);
      const slug = process.env.DEFAULT_SALON_SLUG?.trim();
      const phone = process.env.DEFAULT_SALON_PHONE?.trim();
      if (slug) {
        const { data, error } = await supabase
          .from('organizations')
          .select('id, slug, phone_number')
          .eq('slug', slug)
          .maybeSingle();
        if (error) {
          throw error;
        }
        if (data) {
          console.log('✓ Salon slug', slug, '→ org id', data.id);
          if (phone && data.phone_number !== phone) {
            const { error: upErr } = await supabase
              .from('organizations')
              .update({ phone_number: phone })
              .eq('id', data.id);
            if (upErr) {
              console.warn('⚠ Could not sync phone_number:', upErr.message);
            } else {
              console.log('✓ Updated organizations.phone_number →', phone, '(SIP/dialed-number routing)');
            }
          }
        } else {
          console.warn('⚠ No organization with slug', slug);
        }
      }
    }
  } catch (e) {
    console.warn('⚠ Salon check:', e instanceof Error ? e.message : e);
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
