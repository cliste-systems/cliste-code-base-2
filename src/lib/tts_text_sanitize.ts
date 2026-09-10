/**
 * TTS text preparation — removes forbidden spoken phrases and normalizes text
 * so ElevenLabs does not stress ALL CAPS words or run words together.
 * Streaming-safe: keeps a tail buffer so transforms work across chunks.
 */
import { tokenize } from '@livekit/agents';

import { DEFAULT_ELEVEN_TTS_MODEL } from './tts_config.js';
import { isElevenV3Model } from './elevenlabs-v3-http-tts.js';
import { softenSpokenFarewell } from './natural_phrasing.js';
import { isCartesiaInferenceTtsModel } from './tts_config.js';

const FORBIDDEN_SPOKEN = /\b(end\s+phone\s+call|endphonecall)\b/gi;
/** Irish slang the product owner does not want spoken aloud. */
const UNWANTED_SPOKEN = /\bgrand\b/gi;

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
 [/\bHello Cara\b/gi, 'Hello Kara'],
 [/\bCara\b/g, 'Kara'],
 [/\bFresha\b/gi, 'Fresh-ah'],
 [/\bshellac\b/gi, 'shel-lack'],
 [/\bkeratin\b/gi, 'care-ah-tin'],
 [/\bGrafton\b/gi, 'Graft-on'],
 [/\bDublin\b/gi, 'Dub-lin'],
];

let activeTtsModel =
  process.env.ELEVEN_TTS_MODEL?.trim() || DEFAULT_ELEVEN_TTS_MODEL;

/** Set once per call from agent pipeline so streaming sanitizer knows the live model. */
export function setActiveTtsModelForSanitizer(model: string): void {
  activeTtsModel = model.trim() || DEFAULT_ELEVEN_TTS_MODEL;
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

const HOUR_WORDS = [
  'twelve',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
] as const;

function spokenHour12(hour24: number): string {
  const h = ((hour24 % 12) + 12) % 12 || 12;
  return HOUR_WORDS[h] ?? String(h);
}

function spokenDayPart(hour24: number): string {
  if (hour24 < 12) return 'in the morning';
  if (hour24 < 17) return 'in the afternoon';
  return 'in the evening';
}

function spokenClockTime(hour24: number, minute: number): string {
  const hourPart = spokenHour12(hour24);
  if (minute === 0) {
    return `${hourPart} o'clock ${spokenDayPart(hour24)}`;
  }
  if (minute === 30) {
    return `half past ${hourPart} ${spokenDayPart(hour24)}`;
  }
  if (minute === 15) {
    return `quarter past ${hourPart} ${spokenDayPart(hour24)}`;
  }
  if (minute === 45) {
    return `quarter to ${spokenHour12((hour24 + 1) % 24)} ${spokenDayPart(hour24)}`;
  }
  return `${hourPart} ${minute} ${spokenDayPart(hour24)}`;
}

/** Convert 24h / am-pm clock strings to natural Irish phone speech before TTS. */
function normalizeSpokenTimes(text: string): string {
  let out = text.replace(
    /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/g,
    (_match, hh: string, mm: string) => {
      const hour24 = Number.parseInt(hh, 10);
      const minute = Number.parseInt(mm, 10);
      if (!Number.isFinite(hour24) || !Number.isFinite(minute)) return _match;
      return spokenClockTime(hour24, minute);
    },
  );

  out = out.replace(
    /\b([01]?\d)(?::([0-5]{2}))?\s*(am|pm)\b/gi,
    (_match, hh: string, mm: string | undefined, ampm: string) => {
      let hour24 = Number.parseInt(hh, 10) % 12;
      if (ampm.toLowerCase() === 'pm') hour24 += 12;
      const minute = mm ? Number.parseInt(mm, 10) : 0;
      return spokenClockTime(hour24, minute);
    },
  );

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
      .replace(UNWANTED_SPOKEN, 'lovely')
      // Turbo + style can draw out "alright" — detector accepts "okay" too.
      .replace(/\bis that alright\b/gi, 'is that okay')
      .replace(/\bbye[\s-]*bye[!?.]*/gi, 'take care')
      .replace(/\bgoodbye[!?.]*/gi, 'take care'),
    ttsModel,
  );
  return softenSpokenFarewell(
    applyPronunciationMap(
      normalizeSpokenTimes(collapseStretchedLetters(stripped)),
    ).replace(/\s{2,}/g, ' '),
  );
}

/** Brief pause between sentences — replaces periods so Cartesia does not say "dot". */
const CARTESIA_SENTENCE_BREAK = '<break time="120ms"/>';
/** Greeting-only — same light sentence boundary pause, no comma micro-pauses. */
const CARTESIA_GREETING_SENTENCE_BREAK = '<break time="120ms"/>';

function normalizeCartesiaBase(text: string, ttsModel = activeTtsModel): string {
  let out = normalizeTtsChunk(text, ttsModel).trim();
  out = out.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');
  out = out.replace(/\.{2,}/g, ', ');
  out = out.replace(/\be\.g\.\s*/gi, 'for example, ');
  out = out.replace(/\bi\.e\.\s*/gi, 'that is, ');
  out = out.replace(/\betc\.\s*/gi, 'and so on, ');
  out = out.replace(/\betc\s*$/gi, 'and so on');
  return out;
}

/**
 * Hardcoded greeting — keep the intro brisk; only pause between disclosure sentences.
 */
export function prepareCartesiaGreetingChunk(text: string, ttsModel = activeTtsModel): string {
  let out = normalizeCartesiaBase(text, ttsModel);
  out = out.replace(/([.!?]+)\s*(?=[A-Za-z"'(])/g, `${CARTESIA_GREETING_SENTENCE_BREAK} `);
  out = out.replace(/[.!]+\s*$/g, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Cartesia reads literal "." as the word "dot" on phone — use a short SSML break at
 * sentence boundaries only. Comma/dash micro-pauses sounded staccato on the demo line.
 */
export function prepareCartesiaSpeechChunk(text: string, ttsModel = activeTtsModel): string {
  let out = normalizeCartesiaBase(text, ttsModel);
  out = out.replace(/([.!?]+)\s*(?=[A-Za-z"'(])/g, `${CARTESIA_SENTENCE_BREAK} `);
  // Keep trailing ? for question intonation; strip terminal . !
  out = out.replace(/[.!]+\s*$/g, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** Non-streaming prep for hardcoded greetings — legal wording unchanged. */
export function prepareGreetingForTts(text: string, options?: { commaFlow?: boolean }): string {
  const normalized = normalizeTtsChunk(text).trim();
  if (options?.commaFlow === false) {
    return normalized;
  }
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
  /** When false, keep sentence breaks for live TTS (less rushed than comma-flow). */
  greetingCommaFlow?: boolean;
  ttsModel?: string;
};

/** Unified prep for programmatic session.say() strings (non-greeting). */
export function prepareHardcodedSpeechForTts(
  text: string,
  options?: PrepareHardcodedSpeechOptions,
): string {
  const ttsModel = options?.ttsModel ?? activeTtsModel;
  if (options?.greeting) {
    const greeting = prepareGreetingForTts(text, { commaFlow: options.greetingCommaFlow !== false });
    return isCartesiaInferenceTtsModel(ttsModel) ? prepareCartesiaGreetingChunk(greeting, ttsModel) : greeting;
  }
  const normalized = normalizeTtsChunk(text, ttsModel).trim();
  return isCartesiaInferenceTtsModel(ttsModel) ? prepareCartesiaSpeechChunk(normalized, ttsModel) : normalized;
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
  let lastStreamEmitted = '';
  const enqueueStreamChunk = (
    controller: ReadableStreamDefaultController<string>,
    part: string,
  ) => {
    let chunk = part;
    if (
      lastStreamEmitted &&
      !/\s$/.test(lastStreamEmitted) &&
      chunk.length > 0 &&
      !/^\s/.test(chunk)
    ) {
      chunk = ` ${chunk.trimStart()}`;
    }
    lastStreamEmitted = chunk;
    controller.enqueue(chunk);
  };
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
          let emitEnd = hold.length - TAIL_KEEP;
          const wordBreak = hold.lastIndexOf(' ', emitEnd);
          if (wordBreak > 0) {
            emitEnd = wordBreak + 1;
          }
          const toEmit = hold.slice(0, emitEnd);
          if (toEmit) {
            enqueueStreamChunk(controller, toEmit);
          }
          hold = hold.slice(emitEnd);
        }
        hold = normalizeTtsChunk(hold, ttsModel).trim();
        if (hold.length > 0) {
          enqueueStreamChunk(controller, hold);
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

/** Cartesia: stream sentence-by-sentence for faster first audio; light SSML at boundaries only. */
export function bufferCartesiaStreamBySentence(source: ReadableStream<string>): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      const sentenceStream = bufferTtsStreamBySentence(source, { earlyFlush: false });
      const reader = sentenceStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const prepared = prepareCartesiaSpeechChunk(value);
          if (prepared.length >= 1) {
            controller.enqueue(prepared);
          }
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

/** @deprecated Prefer bufferCartesiaStreamBySentence — full-turn buffering adds reply latency. */
export function bufferTtsStreamForCartesia(source: ReadableStream<string>): ReadableStream<string> {
  return bufferCartesiaStreamBySentence(source);
}

export type BuildTtsNodeInputOptions = {
  provider: 'elevenlabs' | 'cartesia-inference';
  ttsModel?: string;
  /** @deprecated Eleven demo comma flush caused staccato turbo TTS — keep false. */
  earlyFlush?: boolean;
  /** One Cartesia synthesis for hardcoded session.say() (greeting) — avoids comma early-flush replaying the opening. */
  singleUtterance?: boolean;
};

/** Collect programmatic speech into one Cartesia chunk (session.say full greeting). */
export function streamCartesiaSingleUtterance(source: ReadableStream<string>): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      const reader = source.getReader();
      let text = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (typeof value === 'string' && value.length > 0) {
            text += value;
          }
        }
        const trimmed = text.trim();
        if (trimmed.length >= 1) {
          // sayPrepared() already ran prepareHardcodedSpeechForTts — do not double-apply breaks.
          controller.enqueue(trimmed);
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

/** LLM token stream → TTS input, tuned per provider. */
export function buildTtsNodeInputStream(
  source: ReadableStream<string>,
  options: BuildTtsNodeInputOptions,
): ReadableStream<string> {
  if (options.provider === 'cartesia-inference') {
    if (options.singleUtterance) {
      return streamCartesiaSingleUtterance(source);
    }
    return bufferCartesiaStreamBySentence(source);
  }
  if (options.singleUtterance) {
    return streamCartesiaSingleUtterance(source);
  }
  // Eleven turbo: sentence buffer only — word-chunk streaming caused letter-by-letter stutter.
  return bufferTtsStreamBySentence(source, {
    earlyFlush: options.earlyFlush === true,
    ttsModel: options.ttsModel,
  });
}

/**
 * Hold LLM token chunks until a full sentence is ready before ElevenLabs TTS.
 * Prevents turbo "stuck on a letter" when the model streams slowly (auto_mode flush mid-word).
 */
export function bufferTtsStreamBySentence(
  source: ReadableStream<string>,
  options?: { earlyFlush?: boolean; ttsModel?: string },
): ReadableStream<string> {
      const earlyFlush = options?.earlyFlush === true;
      const ttsModel = options?.ttsModel ?? activeTtsModel;
      let lastEnqueued = '';
      const enqueueChunk = (controller: ReadableStreamDefaultController<string>, part: string) => {
        let chunk = part;
        if (
          lastEnqueued &&
          !/\s$/.test(lastEnqueued) &&
          chunk.length > 0 &&
          !/^\s/.test(chunk)
        ) {
          chunk = ` ${chunk.trimStart()}`;
        }
        lastEnqueued = chunk;
        controller.enqueue(chunk);
      };
      return new ReadableStream<string>({
    async start(controller) {
      const sentStream = new tokenize.basic.SentenceTokenizer().stream();
      const reader = source.getReader();
      let pendingInput = '';
      const emittedParts: string[] = [];

      const inputTask = async (): Promise<void> => {
        try {
          let fedToTokenizerEnd = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              sentStream.endInput();
              break;
            }
            if (typeof value !== 'string' || value.length === 0) {
              continue;
            }
            pendingInput += value;
            pendingInput = normalizeTtsChunk(pendingInput, ttsModel);

            if (earlyFlush) {
              const unfed = pendingInput.slice(fedToTokenizerEnd);
              const commaIdx = unfed.length >= 24 ? unfed.search(/[,—–;]\s+\S/) : -1;
              if (commaIdx >= 20) {
                const early = unfed.slice(0, commaIdx + 1).trim();
                if (early) {
                  emittedParts.push(early);
                  enqueueChunk(controller, early);
                  fedToTokenizerEnd += commaIdx + 1;
                }
              }
            }

            const toFeed = pendingInput.slice(fedToTokenizerEnd);
            if (toFeed.length > 0) {
              sentStream.pushText(toFeed);
              fedToTokenizerEnd = pendingInput.length;
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
            enqueueChunk(controller, t);
          }
        }
        const pending = pendingInput.trim();
        if (emittedParts.length === 0) {
          if (pending) {
            enqueueChunk(controller, pending);
          }
          return;
        }
        const joined = emittedParts.join(' ').replace(/\s+/g, ' ');
        const pendingNorm = pending.replace(/\s+/g, ' ');
        if (pendingNorm.length > joined.length && pendingNorm.startsWith(joined)) {
          const tail = pendingNorm.slice(joined.length).trim();
          if (tail) {
            enqueueChunk(controller, tail);
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
