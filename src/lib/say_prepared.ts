import type { voice } from '@livekit/agents';

import { prepareHardcodedSpeechForTts, type PrepareHardcodedSpeechOptions } from './tts_text_sanitize.js';

/** Programmatic speech through the same TTS prep path as LLM output. */
export function sayPrepared(
  session: voice.AgentSession<unknown>,
  text: string,
  options?: PrepareHardcodedSpeechOptions & {
    allowInterruptions?: boolean;
    addToChatCtx?: boolean;
  },
): ReturnType<voice.AgentSession<unknown>['say']> {
  const { greeting, ttsModel, allowInterruptions, addToChatCtx } = options ?? {};
  const prepOptions: PrepareHardcodedSpeechOptions = {};
  if (greeting) prepOptions.greeting = true;
  if (ttsModel) prepOptions.ttsModel = ttsModel;
  return session.say(prepareHardcodedSpeechForTts(text, prepOptions), {
    ...(allowInterruptions !== undefined ? { allowInterruptions } : {}),
    ...(addToChatCtx !== undefined ? { addToChatCtx } : {}),
  });
}
