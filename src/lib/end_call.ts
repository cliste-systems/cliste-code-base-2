import { audioFramesFromFile, voice } from '@livekit/agents';
import { RoomServiceClient } from 'livekit-server-sdk';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { phoneHangupToneFrameStream } from './hangup_tone.js';

function livekitServiceHttpsHost(): string | null {
  const u = process.env.LIVEKIT_URL?.trim();
  if (!u) return null;
  return u.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

function defaultPhoneHangupPath(): string {
  return fileURLToPath(new URL('../assets/phone-hangup.mp3', import.meta.url));
}

function hangupSoundDisabled(): boolean {
  const v = process.env.PHONE_HANGUP_SOUND?.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off';
}

function resolveHangupSoundPath(): string | null {
  if (hangupSoundDisabled()) return null;
  const envPath = process.env.PHONE_HANGUP_SOUND_PATH?.trim();
  if (envPath && existsSync(envPath)) return envPath;
  const defaultPath = defaultPhoneHangupPath();
  return existsSync(defaultPath) ? defaultPath : null;
}

/** Bundled phone-hangup.mp3 is 24 kHz mono — wrong rate sounds crackly/static. */
function hangupAudioOptions() {
  return {
    sampleRate: 24000,
    numChannels: 1,
    format: 'mp3' as const,
  };
}

export function waitForSpeechHandlePlayout(handle: {
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
  const t = normalizeGoodbyeText(text);
  if (!t) return false;
  if (t.split(' ').length > 16) return false;
  return (
    /\b(talk soon|talk to you soon|take care|see you (soon|then|tomorrow|next time)|see ya|cheers now|bye for now|bye bye|goodbye|grand so bye|all the best|have a (good|great|lovely|grand) (day|one|evening|weekend))\b/.test(
      t,
    ) ||
    (/\bthanks for (ringing|calling|trying|the call)\b/.test(t) && !/\?/.test(text)) ||
    /^(grand|lovely|perfect|brilliant|no bother|cheers),?\s*(talk soon|thanks|thank you|bye)\b/.test(t) ||
    /^lovely,?\s*thanks for ringing\b/.test(t) ||
    /\bbye\b/.test(t)
  );
}

/** Farewell that should end the line — explicit bye/thanks-for-calling, never a dangling "have a great day". */
export function assistantTextSoundsLikeTerminalHangup(text: string): boolean {
  if (/\?/.test(text)) return false;
  const t = normalizeGoodbyeText(text);
  if (!t) return false;
  if (t.split(' ').length > 18) return false;
  if (/\b(take care|have a good one|talk soon|lovely speaking)\b/.test(t)) {
    if (/\bthanks for (ringing|calling|trying)\b/.test(t)) return true;
  }
  if (/\b(bye|goodbye|bye for now|bye bye)\b/.test(t)) return true;
  if (/\bthanks for (ringing|calling|trying)\b/.test(t)) return true;
  return /^lovely,?\s*thanks for (ringing|calling|trying)\b/.test(t);
}

/** Demo conversational farewell — auto-hangup when LLM forgets endPhoneCall. */
export function assistantTextSoundsLikeDemoFarewell(text: string): boolean {
  const cleaned = text.replace(/\[[^\]]*\][^\n]*/g, '').trim();
  if (!cleaned || /\?/.test(cleaned)) return false;

  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter((part) => part.trim());
  for (const sentence of sentences) {
    const t = normalizeGoodbyeText(sentence);
    if (!t) continue;
    if (t.split(' ').length > 18) continue;
    if (/\b(i'?ll leave you to it|i'?ll let you go)\b/.test(t)) return true;
    if (/\b(take care(?: now)?|have a good one|chat soon|bye(?: for now)?|goodbye)\s*$/.test(t)) {
      return true;
    }
  }
  return false;
}

function normalizeGoodbyeText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/\*+/g, ' ')
    .replace(/`+/g, ' ')
    .replace(/[!?.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export { buildWarmCallClosingLine, softenSpokenFarewell } from './natural_phrasing.js';

export async function waitForAgentSpeechPlayout(
  session: voice.AgentSession<EndCallUserData>,
  recentHandle?: {
    done(): boolean;
    addDoneCallback: (cb: (sh: unknown) => void) => void;
  } | null,
): Promise<void> {
  if (recentHandle && !recentHandle.done()) {
    try {
      await waitForSpeechHandlePlayout(recentHandle);
    } catch {
      /* fall through to agentState poll */
    }
  }
  const maxMs = Number.parseInt(process.env.LIVEKIT_DISCONNECT_PLAYOUT_MS ?? '2400', 10);
  const pollMs = 60;
  const started = Date.now();
  while (session.agentState === 'speaking' && Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const tailMs = Number.parseInt(process.env.LIVEKIT_END_CALL_POST_SPEECH_MS ?? '120', 10);
  if (Number.isFinite(tailMs) && tailMs > 0) {
    await new Promise((r) => setTimeout(r, Math.min(Math.max(tailMs, 80), 800)));
  }
}

export type EndCallUserData = {
  sessionFlags: { endPhoneCallUsed: boolean };
  endCallTarget?: { roomName: string; callerIdentity: string };
};

export async function waitForSessionPlayout(
  session: voice.AgentSession<EndCallUserData>,
): Promise<void> {
  await waitForAgentSpeechPlayout(session);
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
    await waitForAgentSpeechPlayout(session);

    const resolvedPath = resolveHangupSoundPath();

    let playedSound = false;
    if (resolvedPath) {
      try {
        const audio = audioFramesFromFile(resolvedPath, hangupAudioOptions());
        const handle = session.say('', {
          audio,
          addToChatCtx: false,
          allowInterruptions: false,
        });
        await waitForSpeechHandlePlayout(handle);
        playedSound = true;
      } catch (e) {
        console.error('[end_call] hang-up sound file', e);
      }
    }

    if (!playedSound && !hangupSoundDisabled()) {
      try {
        const handle = session.say('', {
          audio: phoneHangupToneFrameStream(),
          addToChatCtx: false,
          allowInterruptions: false,
        });
        await waitForSpeechHandlePlayout(handle);
        playedSound = true;
      } catch (e) {
        console.error('[end_call] generated hang-up tone', e);
      }
    }

    const postSoundMs = Number.parseInt(process.env.LIVEKIT_END_CALL_POST_SOUND_MS ?? '80', 10);
    const fallbackPadMs = Number.parseInt(process.env.LIVEKIT_END_CALL_DELAY_MS ?? '250', 10);
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