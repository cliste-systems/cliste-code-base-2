import { demoCallerReadyForClose } from './speech_triggers.js';
import { waitForSpeechHandlePlayout } from './end_call.js';

export type DemoCloseArmFlags = {
  askedAnythingElse?: boolean;
  awaitingAnythingElseReply?: boolean;
};

/** Interim STT — partial wind-down before turn commits. */
export function callerSoundsLikeImminentClose(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (/\b(repeat|say that again|can you|could you|before you go)\b/.test(t)) return false;
  return (
    /\b(that'?s all|thats all|that'?s every|thats every|that'?s it|thats it|nothing else)\b/.test(
      t,
    ) ||
    /\b(that'?s everything|thats everything|i'?m sorted|im sorted)\b/.test(t) ||
    /\b(no thanks|no thank you).*(that'?s all|that'?s everything)\b/.test(t) ||
    /\b(that'?s all|that'?s everything).*(thanks|thank you)\b/.test(t)
  );
}

export function shouldArmDemoCloseFromCallerText(
  text: string,
  flags: DemoCloseArmFlags,
  opts?: { interim?: boolean },
): boolean {
  if (opts?.interim) {
    return callerSoundsLikeImminentClose(text);
  }
  return demoCallerReadyForClose(text, flags);
}

export function shouldDropLlmTtsWhileClosing(input: {
  closingCall: boolean;
  preparedSpeechSingleUtteranceNext: boolean;
  singleUtteranceTtsNext: boolean;
}): boolean {
  if (!input.closingCall) return false;
  return !input.preparedSpeechSingleUtteranceNext && !input.singleUtteranceTtsNext;
}

export function emptyTextStream(): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

export async function drainReadableStream(stream: ReadableStream<string>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

type SpeechHandle = {
  done(): boolean;
  addDoneCallback: (cb: (sh: unknown) => void) => void;
};

/** Brief wait after interrupt so stray LLM TTS does not overlap the programmatic outro. */
export async function settleInterruptedAgentSpeech(
  session: { agentState: string },
  opts: {
    isGenerateReplyInFlight: () => boolean;
    lastHandle?: SpeechHandle | null;
    maxMs?: number;
  },
): Promise<void> {
  const maxMs = opts.maxMs ?? 450;
  const pollMs = 40;
  const started = Date.now();
  while (
    (session.agentState === 'speaking' || opts.isGenerateReplyInFlight()) &&
    Date.now() - started < maxMs
  ) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const handle = opts.lastHandle;
  if (handle && !handle.done()) {
    try {
      await Promise.race([
        waitForSpeechHandlePlayout(handle),
        new Promise<void>((resolve) => setTimeout(resolve, maxMs)),
      ]);
    } catch {
      /* ignore */
    }
  }
}
