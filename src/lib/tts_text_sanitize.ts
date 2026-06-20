/**
 * TTS text preparation — removes forbidden spoken phrases and normalizes text
 * so ElevenLabs does not stress ALL CAPS words or run words together.
 * Streaming-safe: keeps a tail buffer so transforms work across chunks.
 */
const FORBIDDEN_SPOKEN = /\b(end\s+phone\s+call|endphonecall)\b/gi;

/** Length of tail retained across chunks (longer than longest forbidden phrase). */
const TAIL_KEEP = 28;

/** Lowercase words that are fully ALL CAPS (2+ letters) — avoids odd TTS stress. */
const ALL_CAPS_WORD = /\b[A-Z]{2,}\b/g;

/** Never read URLs aloud — strip from TTS output. */
const URL_PATTERN = /https?:\/\/\S+/gi;

function normalizeTtsChunk(text: string): string {
  return text
    .replace(ALL_CAPS_WORD, (word) => (word === 'AI' ? word : word.toLowerCase()))
    .replace(URL_PATTERN, '')
    .replace(FORBIDDEN_SPOKEN, '')
    .replace(/\s{2,}/g, ' ');
}

/** Non-streaming prep for hardcoded greetings — legal wording unchanged. */
export function prepareGreetingForTts(text: string): string {
  return normalizeTtsChunk(text).trim();
}

export function prepareTextForTtsStreaming(source: ReadableStream<string>): ReadableStream<string> {
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
          hold = normalizeTtsChunk(hold);
          if (hold.length <= TAIL_KEEP) {
            continue;
          }
          const emitLen = hold.length - TAIL_KEEP;
          controller.enqueue(hold.slice(0, emitLen));
          hold = hold.slice(emitLen);
        }
        hold = normalizeTtsChunk(hold).trim();
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
