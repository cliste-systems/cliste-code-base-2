/**
 * Removes phrases the model sometimes speaks instead of invoking tools (TTS should not read them).
 * Streaming-safe: keeps a tail buffer so a phrase split across chunks is still removed.
 */
const FORBIDDEN_SPOKEN = /\b(end\s+phone\s+call|endphonecall)\b/gi;

/** Length of tail retained across chunks (longer than longest forbidden phrase). */
const TAIL_KEEP = 28;

export function stripForbiddenTtsPhrasesStreaming(source: ReadableStream<string>): ReadableStream<string> {
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
          hold = hold.replace(FORBIDDEN_SPOKEN, '').replace(/\s{2,}/g, ' ');
          if (hold.length <= TAIL_KEEP) {
            continue;
          }
          const emitLen = hold.length - TAIL_KEEP;
          controller.enqueue(hold.slice(0, emitLen));
          hold = hold.slice(emitLen);
        }
        hold = hold.replace(FORBIDDEN_SPOKEN, '').replace(/\s{2,}/g, ' ').trim();
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
