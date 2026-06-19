import { audioFramesFromFile, voice } from '@livekit/agents';
import { RoomServiceClient } from 'livekit-server-sdk';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function livekitServiceHttpsHost(): string | null {
  const u = process.env.LIVEKIT_URL?.trim();
  if (!u) return null;
  return u.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

function defaultPhoneHangupPath(): string {
  return fileURLToPath(new URL('../assets/phone-hangup.mp3', import.meta.url));
}

function waitForSpeechHandlePlayout(handle: {
  done(): boolean;
  addDoneCallback: (cb: (sh: unknown) => void) => void;
}): Promise<void> {
  if (handle.done()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Hang-up sound playout timed out')), 25_000);
    handle.addDoneCallback(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

export function assistantTextSoundsLikeFakeHangup(text: string): boolean {
  const t = text.replace(/\*+/g, ' ').replace(/`+/g, ' ').toLowerCase();
  return /\b(end\s+phone\s+call|endphonecall)\b/.test(t);
}

export function assistantTextSoundsLikeGoodbye(text: string): boolean {
  const t = text
    .replace(/\*+/g, ' ')
    .replace(/`+/g, ' ')
    .replace(/[!?.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!t) return false;
  if (t.split(' ').length > 14) return false;
  return (
    /\b(talk soon|talk to you soon|take care|see you (soon|then|tomorrow|next time)|see ya|cheers now|bye for now|bye bye|goodbye|grand so bye|all the best|have a (good|lovely|grand) (day|one|evening|weekend))\b/.test(
      t,
    ) ||
    (/\bthanks for (ringing|calling|the call)\b/.test(t) && !/\?/.test(text)) ||
    /^(grand|lovely|perfect|brilliant|no bother|cheers),?\s*(talk soon|thanks|thank you|bye)\b/.test(t) ||
    /^lovely,?\s*thanks for ringing\b/.test(t)
  );
}

export type EndCallUserData = {
  sessionFlags: { endPhoneCallUsed: boolean };
  endCallTarget?: { roomName: string; callerIdentity: string };
};

export async function waitForSessionPlayout(
  _session: voice.AgentSession<EndCallUserData>,
): Promise<void> {
  const ms = Number.parseInt(process.env.LIVEKIT_DISCONNECT_PLAYOUT_MS ?? '1200', 10);
  const delay = Number.isFinite(ms) ? Math.min(Math.max(ms, 300), 5000) : 1200;
  await new Promise((r) => setTimeout(r, delay));
}

export async function disconnectCallerLeg(
  session: voice.AgentSession<EndCallUserData>,
  ud: EndCallUserData,
  beforeAudio: () => Promise<void>,
): Promise<{ ok: boolean; message: string }> {
  if (ud.sessionFlags.endPhoneCallUsed) {
    return { ok: false, message: 'Hang-up already requested; do not speak again.' };
  }
  const target = ud.endCallTarget;
  if (!target?.roomName?.trim() || !target.callerIdentity?.trim()) {
    return {
      ok: false,
      message:
        'Cannot hang up from this session. Tell them goodbye and they can hang up when ready.',
    };
  }
  const host = livekitServiceHttpsHost();
  const key = process.env.LIVEKIT_API_KEY?.trim();
  const secret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!host || !key || !secret) {
    console.error('[end_call] missing LIVEKIT_URL or API credentials');
    return {
      ok: false,
      message:
        'Server could not end the line automatically. Say goodbye warmly and ask them to hang up.',
    };
  }
  ud.sessionFlags.endPhoneCallUsed = true;

  try {
    await beforeAudio();

    const envPath = process.env.PHONE_HANGUP_SOUND_PATH?.trim();
    const resolvedPath =
      envPath && existsSync(envPath) ? envPath : defaultPhoneHangupPath();

    let playedSound = false;
    if (existsSync(resolvedPath)) {
      try {
        const audio = audioFramesFromFile(resolvedPath, {
          sampleRate: 48000,
          numChannels: 1,
          format: 'mp3',
        });
        const handle = session.say(' ', {
          audio,
          addToChatCtx: false,
          allowInterruptions: false,
        });
        await waitForSpeechHandlePlayout(handle);
        playedSound = true;
      } catch (e) {
        console.error('[end_call] hang-up sound', e);
      }
    }

    const postSoundMs = Number.parseInt(process.env.LIVEKIT_END_CALL_POST_SOUND_MS ?? '200', 10);
    const fallbackPadMs = Number.parseInt(process.env.LIVEKIT_END_CALL_DELAY_MS ?? '1200', 10);
    const extraMs = playedSound
      ? Number.isFinite(postSoundMs)
        ? Math.min(Math.max(postSoundMs, 0), 5000)
        : 200
      : Number.isFinite(fallbackPadMs)
        ? Math.min(Math.max(fallbackPadMs, 300), 15000)
        : 1200;
    await new Promise((r) => setTimeout(r, extraMs));

    const client = new RoomServiceClient(host, key, secret);
    await client.removeParticipant(target.roomName.trim(), target.callerIdentity.trim());
    return {
      ok: true,
      message:
        'Call is ending. Do not generate more speech unless the caller speaks again before disconnect.',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[end_call]', msg);
    ud.sessionFlags.endPhoneCallUsed = false;
    return {
      ok: false,
      message: `Hang-up failed (${msg}). Say goodbye and ask them to hang up.`,
    };
  }
}