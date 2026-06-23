/**
 * TTS text preparation — removes forbidden spoken phrases and normalizes text
 * so ElevenLabs does not stress ALL CAPS words or run words together.
 * Streaming-safe: keeps a tail buffer so transforms work across chunks.
 */
import { tokenize } from '@livekit/agents';

import { isElevenV3Model } from './elevenlabs-v3-http-tts.js';

const FORBIDDEN_SPOKEN = /\b(end\s+phone\s+call|endphonecall)\b/gi;

/** Length of tail retained across chunks (longer than longest forbidden phrase). */
const TAIL_KEEP = 28;

/** Lowercase words that are fully ALL CAPS (2+ letters) — avoids odd TTS stress. */
const ALL_CAPS_WORD = /\b[A-Z]{2,}\b/g;

/** Never read URLs aloud — strip from TTS output. */
const URL_PATTERN = /https?:\/\/\S+/gi;

/** v3 expressive tags — must not be spoken on turbo/flash. */
const V3_AUDIO_TAG = /\[(?:warm|pause|softly|laughs|\w+)\]/gi;

/** Tricky terms → TTS-friendly spellings (word-boundary replacements). */
const PRONUNCIATION_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
 [/\bFresha\b/gi, 'Fresh-ah'],
 [/\bshellac\b/gi, 'shel-lack'],
 [/\bkeratin\b/gi, 'care-ah-tin'],
 [/\bGrafton\b/gi, 'Graft-on'],
 [/\bDublin\b/gi, 'Dub-lin'],
];

let activeTtsModel =
  process.env.ELEVEN_TTS_MODEL?.trim() || 'eleven_turbo_v2_5';

/** Set once per call from agent pipeline so streaming sanitizer knows the live model. */
export function setActiveTtsModelForSanitizer(model: string): void {
  activeTtsModel = model.trim() || 'eleven_turbo_v2_5';
}

export function getActiveTtsModelForSanitizer(): string {
  return activeTtsModel;
}

function applyPronunciationMap(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PRONUNCIATION_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** LLM emphasis like "hellooooo" — turbo reads repeated letters as a long scream. */
function collapseStretchedLetters(text: string): string {
  return text.replace(/(.)\1{2,}/g, '$1');
}

function stripV3TagsUnlessV3(text: string, ttsModel: string): string {
  if (isElevenV3Model(ttsModel)) {
    return text;
  }
  return text.replace(V3_AUDIO_TAG, '');
}

function normalizeTtsChunk(text: string, ttsModel = activeTtsModel): string {
  const stripped = stripV3TagsUnlessV3(
    text
      .replace(ALL_CAPS_WORD, (word) => (word === 'AI' ? word : word.toLowerCase()))
      .replace(URL_PATTERN, '')
      .replace(FORBIDDEN_SPOKEN, '')
      // Turbo + style can draw out "alright" — detector accepts "okay" too.
      .replace(/\bis that alright\b/gi, 'is that okay')
      .replace(/\bbye[\s-]*bye[!?.]*/gi, 'bye for now')
      .replace(/\bgoodbye[!?.]*/gi, 'bye for now'),
    ttsModel,
  );
  return applyPronunciationMap(collapseStretchedLetters(stripped)).replace(/\s{2,}/g, ' ');
}

/** Non-streaming prep for hardcoded greetings — legal wording unchanged. */
export function prepareGreetingForTts(text: string): string {
  const normalized = normalizeTtsChunk(text).trim();
  const parts = normalized.split(/\.\s+/).filter((p) => p.length > 0);
  if (parts.length < 3 || parts.length > 6) {
    return normalized;
  }
  const head = parts[0]!;
  const tail = parts[parts.length - 1]!;
  const middle = parts.slice(1, -1).join(', ');
  const tailFlow = /^[A-Z]/.test(tail) ? `${tail.charAt(0).toLowerCase()}${tail.slice(1)}` : tail;
  return middle ? `${head}, ${middle}, ${tailFlow}` : `${head}, ${tailFlow}`;
}

export type PrepareHardcodedSpeechOptions = {
  greeting?: boolean;
  ttsModel?: string;
};

/** Unified prep for programmatic session.say() strings (non-greeting). */
export function prepareHardcodedSpeechForTts(
  text: string,
  options?: PrepareHardcodedSpeechOptions,
): string {
  if (options?.greeting) {
    return prepareGreetingForTts(text);
  }
  return normalizeTtsChunk(text, options?.ttsModel ?? activeTtsModel).trim();
}

export type PrepareStreamingOptions = {
  ttsModel?: string;
};

export function prepareTextForTtsStreaming(
  source: ReadableStream<string>,
  options?: PrepareStreamingOptions,
): ReadableStream<string> {
  const ttsModel = options?.ttsModel ?? activeTtsModel;
  let hold = '';
  return new ReadableStream<string>({
    async start(controller) {
      const reader = source.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (typeof value !== 'string' || value.length === 0) {
            continue;
          }
          hold += value;
          hold = normalizeTtsChunk(hold, ttsModel);
          if (hold.length <= TAIL_KEEP) {
            continue;
          }
          const emitLen = hold.length - TAIL_KEEP;
          controller.enqueue(hold.slice(0, emitLen));
          hold = hold.slice(emitLen);
        }
        hold = normalizeTtsChunk(hold, ttsModel).trim();
        if (hold.length > 0) {
          controller.enqueue(hold);
        }
        controller.close();
      } catch (e) {
        controller.error(e instanceof Error ? e : new Error(String(e)));
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      return source.cancel(reason);
    },
  });
}

/** @deprecated Use prepareTextForTtsStreaming — kept as alias for compatibility. */
export function stripForbiddenTtsPhrasesStreaming(source: ReadableStream<string>): ReadableStream<string> {
  return prepareTextForTtsStreaming(source);
}

/**
 * Hold LLM token chunks until a full sentence is ready before ElevenLabs TTS.
 * Prevents turbo "stuck on a letter" when the model streams slowly (auto_mode flush mid-word).
 */
export function bufferTtsStreamBySentence(source: ReadableStream<string>): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      const sentStream = new tokenize.basic.SentenceTokenizer().stream();
      const reader = source.getReader();
      let pendingInput = '';
      const emittedParts: string[] = [];

      const inputTask = async (): Promise<void> => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              sentStream.endInput();
              break;
            }
            if (typeof value === 'string' && value.length > 0) {
              pendingInput += value;
              sentStream.pushText(value);
            }
          }
        } finally {
          reader.releaseLock();
        }
      };

      const outputTask = async (): Promise<void> => {
        for await (const ev of sentStream) {
          const t = ev.token?.trim();
          if (t) {
            emittedParts.push(t);
            controller.enqueue(t);
          }
        }
        const pending = pendingInput.trim();
        if (emittedParts.length === 0) {
          if (pending) {
            controller.enqueue(pending);
          }
          return;
        }
        const joined = emittedParts.join(' ').replace(/\s+/g, ' ');
        const pendingNorm = pending.replace(/\s+/g, ' ');
        if (pendingNorm.length > joined.length && pendingNorm.startsWith(joined)) {
          const tail = pendingNorm.slice(joined.length).trim();
          if (tail) {
            controller.enqueue(tail);
          }
        }
      };

      try {
        await Promise.all([inputTask(), outputTask()]);
        controller.close();
      } catch (e) {
        controller.error(e instanceof Error ? e : new Error(String(e)));
      }
    },
    cancel(reason) {
      return source.cancel(reason);
    },
  });
}
