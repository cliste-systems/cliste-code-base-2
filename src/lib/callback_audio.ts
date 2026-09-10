import { audioFramesFromFile, voice } from '@livekit/agents';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TYPING_PLAY_MS = 1500;

function defaultTypingSoundPath(): string {
  return fileURLToPath(new URL('../assets/typing.mp3', import.meta.url));
}

export function caraTypingSoundEnabled(): boolean {
  const v = process.env.CARA_TYPING_SOUND?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function resolveTypingSoundPath(): string | null {
  const envPath = process.env.CARA_TYPING_SOUND_PATH?.trim();
  if (envPath && existsSync(envPath)) return envPath;
  const defaultPath = defaultTypingSoundPath();
  return existsSync(defaultPath) ? defaultPath : null;
}

/** Fire-and-forget subtle typing cue during takeCallbackMessage — never await in tool execute. */
export function playTypingSound(session: voice.AgentSession<unknown>): void {
  if (!caraTypingSoundEnabled()) return;
  const path = resolveTypingSoundPath();
  if (!path) {
    console.warn('[callback_audio] typing sound file missing');
    return;
  }

  const abort = new AbortController();
  const stopTimer = setTimeout(() => abort.abort(), TYPING_PLAY_MS);

  void (async () => {
    try {
      const audio = audioFramesFromFile(path, {
        sampleRate: 24000,
        numChannels: 1,
        format: 'mp3',
        abortSignal: abort.signal,
      });
      session.say('', {
        audio,
        addToChatCtx: false,
        allowInterruptions: true,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      console.warn('[callback_audio] typing sound failed', err);
    } finally {
      clearTimeout(stopTimer);
    }
  })();
}
