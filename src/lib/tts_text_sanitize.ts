/**
 * TTS text preparation — removes forbidden spoken phrases and normalizes text
 * for Cartesia via LiveKit Inference.
 */
import { tokenize } from '@livekit/agents';

import { softenSpokenFarewell } from './natural_phrasing.js';
import { speakEmbeddedEurAmounts } from './spoken_eur_price.js';

const FORBIDDEN_SPOKEN = /\b(end\s+phone\s+call|endphonecall)\b/gi;
/** Irish slang the product owner does not want spoken aloud. */
const UNWANTED_SPOKEN = /\bgrand\b/gi;

/** Lowercase words that are fully ALL CAPS (2+ letters) — avoids odd TTS stress. */
const ALL_CAPS_WORD = /\b[A-Z]{2,}\b/g;

/** Never read URLs aloud — strip from TTS output. */
const URL_PATTERN = /https?:\/\/\S+/gi;

/** LLM stage directions / fake tool annotations — never spoken aloud. */
const BRACKET_STAGE_DIRECTION = /\[[^\]]*\][^\n]*/g;

/** Model control tokens (e.g. <|end|>) — strip before TTS. */
const MODEL_CONTROL_TOKEN = /<\|[^|>]*\|>/g;

/** Emoji and pictographs — never spoken on a phone call. */
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

/** Leading acknowledgement directly before a name — insert comma for natural pacing. */
const LEADING_ACK_BEFORE_NAME =
  /^(Grand|Lovely|Perfect|Brilliant|No bother|Sound|Ah grand|Ah)\s+([A-Z][a-z]+)\b/;

/** Tricky terms → TTS-friendly spellings (word-boundary replacements). */
const PRONUNCIATION_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\bHello Cara\b/gi, 'Hello Kara'],
  [/\bCara\b/g, 'Kara'],
  [/\bKavanaghs\b/gi, 'Kavanahs'],
  [/\bGrafton\b/gi, 'Graft-on'],
  [/\bDublin\b/gi, 'Dub-lin'],
  [/\bDonegal Town\b/gi, 'Doneygall Town'],
  [/\bDonegal\b/gi, 'Doneygall'],
  [/\bSt\.?\s+Patrick'?s?\s+Day\b/gi, "Saint Patrick's Day"],
  [/\bgarages\b/gi, 'gar-idges'],
  [/\bgarage\b/gi, 'gar-idge'],
];

let activeTtsModel = process.env.LIVEKIT_INFERENCE_TTS_MODEL?.trim() || 'cartesia/sonic-3.6';

/** Set once per call from agent pipeline so streaming sanitizer knows the live model. */
export function setActiveTtsModelForSanitizer(model: string): void {
  activeTtsModel = model.trim() || 'cartesia/sonic-3.6';
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

/** LLM emphasis like "hellooooo" — repeated letters can sound unnatural on phone TTS. */
function collapseStretchedLetters(text: string): string {
  return text.replace(/(.)\1{2,}/g, '$1');
}

function insertLeadingAckComma(text: string): string {
  return text.replace(LEADING_ACK_BEFORE_NAME, '$1, $2');
}

function normalizeTtsChunk(text: string, ttsModel = activeTtsModel): string {
  let normalized = text
    .replace(MODEL_CONTROL_TOKEN, '')
    .replace(EMOJI_PATTERN, '')
    .replace(ALL_CAPS_WORD, (word) => (word === 'AI' ? word : word.toLowerCase()));
  normalized = insertLeadingAckComma(normalized);
  const stripped = normalized
    .replace(URL_PATTERN, '')
    .replace(FORBIDDEN_SPOKEN, '')
    .replace(UNWANTED_SPOKEN, 'lovely')
    .replace(/\bis that alright\b/gi, 'is that okay')
    .replace(/\bbye[\s-]*bye[!?.]*/gi, 'take care')
    .replace(/\bgoodbye[!?.]*/gi, 'take care')
    .replace(BRACKET_STAGE_DIRECTION, '');
  return softenSpokenFarewell(
    applyPronunciationMap(
      speakEmbeddedEurAmounts(
        normalizeSpokenTimes(collapseStretchedLetters(stripped)),
      ),
    ).replace(/\s{2,}/g, ' '),
  );
}

/** Brief pause between sentences — replaces periods so Cartesia does not say "dot". */
const CARTESIA_SENTENCE_BREAK = '<break time="240ms"/>';
/** Demo outro / goodbye — slower, warmer cadence. */
const CARTESIA_OUTRO_BREAK = '<break time="400ms"/>';
/** Greeting-only — keep the intro brisk; no comma micro-pauses. */
const CARTESIA_GREETING_SENTENCE_BREAK = '<break time="160ms"/>';
/** Kavanaghs-style retail opening — slightly clearer than demo, not sluggish. */
const CARTESIA_RETAIL_OPENING_BREAK = '<break time="240ms"/>';
/** Comma-run-on before a question clause — treat like a sentence boundary. */
const CARTESIA_COMMA_BEFORE_QUESTION =
  /,\s*(?=(?:want to|would you|what|who|are you|is there|is that|do you|did you|can you|could you|how)\b)/gi;

/** Demo outro / goodbye chunks — slower TTS pacing than mid-call speech. */
export function isFarewellSpeechChunk(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\bthanks for calling\b/.test(t) ||
    /\bbye for now\b/.test(t) ||
    /\bhave a good (day|evening|one)\b/.test(t) ||
    /\btake care(?: now)?\b/.test(t)
  );
}

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

/** Slower retail store opening — natural pauses at sentence boundaries only. */
export function prepareCartesiaRetailOpeningChunk(text: string, ttsModel = activeTtsModel): string {
  let out = normalizeCartesiaBase(text, ttsModel);
  out = out.replace(/([.!?]+)\s*(?=[A-Za-z"'(])/g, `${CARTESIA_RETAIL_OPENING_BREAK} `);
  out = out.replace(/[.!]+\s*$/g, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Cartesia reads literal "." as the word "dot" on phone — use a short SSML break at
 * sentence boundaries only.
 */
export function prepareCartesiaSpeechChunk(text: string, ttsModel = activeTtsModel): string {
  let out = normalizeCartesiaBase(text, ttsModel);
  const farewell = isFarewellSpeechChunk(out);
  const sentenceBreak = farewell ? CARTESIA_OUTRO_BREAK : CARTESIA_SENTENCE_BREAK;

  if (farewell) {
    out = out.replace(/^([A-Za-z][^—\n]{0,48}?)\s*[—–-]\s*/, `$1 ${CARTESIA_OUTRO_BREAK} `);
  }

  out = out.replace(CARTESIA_COMMA_BEFORE_QUESTION, ` ${sentenceBreak} `);
  out = out.replace(/([.!?]+)\s*(?=[A-Za-z"'(])/g, `${sentenceBreak} `);
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
  /** Slower Cartesia pacing for Kavanaghs-style retail opening. */
  greetingRetailOpening?: boolean;
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
    return options.greetingRetailOpening
      ? prepareCartesiaRetailOpeningChunk(greeting, ttsModel)
      : prepareCartesiaGreetingChunk(greeting, ttsModel);
  }
  const normalized = normalizeTtsChunk(text, ttsModel).trim();
  return prepareCartesiaSpeechChunk(normalized, ttsModel);
}

/** Cartesia: stream sentence-by-sentence for faster first audio; light SSML at boundaries only. */
export function bufferCartesiaStreamBySentence(source: ReadableStream<string>): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      const sentenceStream = bufferTtsStreamBySentence(source);
      const reader = sentenceStream.getReader();
      let chunkIndex = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const prepared = prepareCartesiaSpeechChunk(value);
          if (prepared.length >= 1) {
            const chunkBreak = isFarewellSpeechChunk(value)
              ? CARTESIA_OUTRO_BREAK
              : CARTESIA_SENTENCE_BREAK;
            const withBreak = chunkIndex > 0 ? `${chunkBreak} ${prepared}` : prepared;
            controller.enqueue(withBreak);
            chunkIndex += 1;
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

export type BuildTtsNodeInputOptions = {
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

/** LLM token stream → Cartesia TTS input. */
export function buildTtsNodeInputStream(
  source: ReadableStream<string>,
  options?: BuildTtsNodeInputOptions,
): ReadableStream<string> {
  if (options?.singleUtterance) {
    return streamCartesiaSingleUtterance(source);
  }
  return bufferCartesiaStreamBySentence(source);
}

/** Hold LLM token chunks until a full sentence is ready before TTS. */
export function bufferTtsStreamBySentence(
  source: ReadableStream<string>,
  options?: { ttsModel?: string },
): ReadableStream<string> {
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
