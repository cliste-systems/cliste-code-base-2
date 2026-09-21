import { assistantReplyLooksLikeClarificationRequest } from './stt_garble.js';

/** LiveKit data topic — must match CLI and admin UI. */
export const TEXT_REHEARSAL_TOPIC = 'cara_text_rehearsal';

export const TEXT_REHEARSAL_ROOM_PREFIX = 'text-rehearsal-';

export const TEXT_REHEARSAL_METADATA_SOURCE = 'text_rehearsal';

export type TextRehearsalInboundPacket =
  | { type: 'caller_turn'; text: string; turnId: string; skipGreeting?: boolean }
  | { type: 'ping'; turnId?: string }
  | { type: 'end_session' };

export type TextRehearsalToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type TextRehearsalOutboundPacket =
  | { type: 'session_ready'; greeting?: string | null }
  | { type: 'assistant_line'; turnId: string; text: string; spoken?: string | null }
  | { type: 'tool_call'; turnId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; turnId: string; name: string; ok: boolean; message: string }
  | { type: 'lookup_filler'; turnId: string; text: string }
  | { type: 'turn_complete'; turnId: string; assistant: string; tools: TextRehearsalToolCall[] }
  | { type: 'pong'; turnId?: string }
  | { type: 'error'; message: string; turnId?: string };

export type TextRehearsalScenarioExpect = {
  clarification?: boolean;
  must_not_quote_prices?: boolean;
  must_mention?: string[];
  must_not_contain?: string[];
  fulfilment?: 'counter' | 'prepack';
};

export type TextRehearsalScenario = {
  name: string;
  turns: string[];
  expect?: TextRehearsalScenarioExpect;
};

export type TextRehearsalScenarioResult = {
  name: string;
  passed: boolean;
  failures: string[];
  transcript: string[];
};

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** Explicit env opt-in — required in production; optional in local dev. */
export function isTextRehearsalEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return envFlag('CARA_TEXT_REHEARSAL');
  }
  return envFlag('CARA_TEXT_REHEARSAL');
}

function parseMetadataSource(metadata: string | null | undefined): string | undefined {
  if (!metadata?.trim()) return undefined;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const source = parsed.source;
    return typeof source === 'string' ? source.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isExplicitTextRehearsalRoom(input: {
  jobMetadata?: string | null;
  roomMetadata?: string | null;
  roomName?: string | null;
}): boolean {
  if (parseMetadataSource(input.jobMetadata) === TEXT_REHEARSAL_METADATA_SOURCE) {
    return true;
  }
  if (parseMetadataSource(input.roomMetadata) === TEXT_REHEARSAL_METADATA_SOURCE) {
    return true;
  }
  return (input.roomName ?? '').trim().startsWith(TEXT_REHEARSAL_ROOM_PREFIX);
}

export function isTextRehearsalSession(input: {
  jobMetadata?: string | null;
  roomMetadata?: string | null;
  roomName?: string | null;
}): boolean {
  if (!isExplicitTextRehearsalRoom(input)) return false;
  if (process.env.NODE_ENV === 'production') {
    return isTextRehearsalEnabled();
  }
  // Local dev: text-rehearsal-* rooms always use the text path (no extra env needed).
  return true;
}

export function buildTextRehearsalRoomName(id?: string): string {
  const suffix = id?.trim() || crypto.randomUUID();
  return `${TEXT_REHEARSAL_ROOM_PREFIX}${suffix}`;
}

export function buildTextRehearsalDispatchMetadata(input: {
  calledNumber: string;
  callerNumber?: string;
  organizationId?: string;
  organizationSlug?: string;
  skipGreeting?: boolean;
}): string {
  return JSON.stringify({
    phone_number: input.calledNumber.trim(),
    caller_number: (input.callerNumber ?? '+353870000001').trim(),
    source: TEXT_REHEARSAL_METADATA_SOURCE,
    ...(input.organizationId?.trim()
      ? { organization_id: input.organizationId.trim() }
      : {}),
    ...(input.organizationSlug?.trim()
      ? { organization_slug: input.organizationSlug.trim() }
      : {}),
    ...(input.skipGreeting ? { skip_greeting: true } : {}),
  });
}

export function parseTextRehearsalSkipGreeting(metadata: string | null | undefined): boolean {
  if (!metadata?.trim()) return false;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return parsed.skip_greeting === true;
  } catch {
    return false;
  }
}

type ReplyPipelineHandle = {
  done(): boolean;
  addDoneCallback: (cb: (sh: unknown) => void) => void;
};

export function parseTextRehearsalToolOutput(raw: unknown): { ok: boolean; message: string } {
  if (typeof raw === 'string') {
    try {
      return parseTextRehearsalToolOutput(JSON.parse(raw));
    } catch {
      return { ok: true, message: raw.trim() };
    }
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const message =
      typeof record.message === 'string'
        ? record.message
        : JSON.stringify(record).slice(0, 500);
    return { ok: record.ok !== false, message };
  }
  return { ok: true, message: '' };
}

/** Wait for LLM/tool pipeline — not TTS playout (text rehearsal must not block on audio). */
export function waitForReplyPipelineDone(
  handle: ReplyPipelineHandle,
  timeoutMs: number,
): Promise<void> {
  if (handle.done()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('Assistant reply timed out')),
      timeoutMs,
    );
    handle.addDoneCallback(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Text rehearsal: resolve when this turn's assistant text is ready and the pipeline settled. */
export function waitForTextRehearsalTurnReply(input: {
  handle: ReplyPipelineHandle;
  getAssistantText: () => string;
  isAgentListening: () => boolean;
  timeoutMs: number;
}): Promise<void> {
  const { handle, getAssistantText, isAgentListening, timeoutMs } = input;
  const ready = () => {
    const text = getAssistantText().trim();
    if (!text) return false;
    return handle.done() || isAgentListening();
  };
  if (ready()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Assistant reply timed out')),
      timeoutMs,
    );
    const finish = () => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const tryFinish = () => {
      if (ready()) finish();
    };
    handle.addDoneCallback(() => tryFinish());
    const poll = setInterval(tryFinish, 100);
    tryFinish();
  });
}

export function encodeTextRehearsalPacket(packet: TextRehearsalInboundPacket | TextRehearsalOutboundPacket): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(packet));
}

export function parseTextRehearsalPacket(payload: Uint8Array | string): TextRehearsalInboundPacket | TextRehearsalOutboundPacket | null {
  try {
    const raw =
      typeof payload === 'string'
        ? payload
        : new TextDecoder().decode(payload);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed as TextRehearsalInboundPacket | TextRehearsalOutboundPacket;
  } catch {
    return null;
  }
}

const PRICE_PATTERN =
  /(?:€|\beur(?:o)?s?\b|\bfor\s+\d|\b\d+(?:\.\d{1,2})?\s*(?:euro|cent|cents)\b|\b\d+\s*c\b)/i;

export function assistantTextQuotesPrices(text: string): boolean {
  return PRICE_PATTERN.test(text.trim());
}

export function assistantReplyLooksLikeRetailFulfilmentClarification(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (assistantReplyLooksLikeClarificationRequest(t)) return true;
  if (!/\?/.test(t)) return false;
  return /\b(counter|pre-?pack|aisle|butcher|fresh|per kilo|kilo)\b/i.test(t);
}

export function inferAssistantFulfilment(text: string): 'counter' | 'prepack' | null {
  const t = text.toLowerCase();
  const counter =
    /\bper kilo\b|\bfresh counter\b|\bbutcher counter\b|\bcounter price\b|\bat the counter\b/.test(
      t,
    );
  const prepack =
    /\bpre-?pack\b|\bin the aisle\b|\bpack(s)? in the meat aisle\b|\bdenny\b/.test(t);
  if (counter && !prepack) return 'counter';
  if (prepack && !counter) return 'prepack';
  return null;
}

export function evaluateTextRehearsalExpectations(input: {
  assistantLines: string[];
  toolCalls: TextRehearsalToolCall[];
  expect?: TextRehearsalScenarioExpect;
}): string[] {
  const expect = input.expect;
  if (!expect) return [];
  const failures: string[] = [];
  const assistant = input.assistantLines.join('\n').trim();
  const lastAssistant = input.assistantLines.at(-1)?.trim() ?? '';
  const lastTool = input.toolCalls.at(-1);

  if (expect.clarification === true) {
    const clarified =
      assistantReplyLooksLikeRetailFulfilmentClarification(lastAssistant) ||
      input.toolCalls.some((tool) => Boolean(tool.args.fulfilment) === false && tool.name === 'searchSuperValuProducts');
    if (!clarified && !assistantReplyLooksLikeRetailFulfilmentClarification(assistant)) {
      failures.push('expected clarification question');
    }
  }

  if (expect.clarification === false && assistantReplyLooksLikeRetailFulfilmentClarification(lastAssistant)) {
    failures.push('unexpected clarification question');
  }

  if (expect.must_not_quote_prices && assistantTextQuotesPrices(assistant)) {
    failures.push('assistant quoted prices');
  }

  for (const phrase of expect.must_mention ?? []) {
    if (!assistant.toLowerCase().includes(phrase.toLowerCase())) {
      failures.push(`missing must_mention: ${phrase}`);
    }
  }

  for (const phrase of expect.must_not_contain ?? []) {
    if (assistant.toLowerCase().includes(phrase.toLowerCase())) {
      failures.push(`contains must_not_contain: ${phrase}`);
    }
  }

  if (expect.fulfilment) {
    const toolFulfilment =
      typeof lastTool?.args.fulfilment === 'string'
        ? lastTool.args.fulfilment
        : null;
    const inferred = inferAssistantFulfilment(lastAssistant);
    const actual = toolFulfilment ?? inferred;
    if (actual !== expect.fulfilment) {
      failures.push(`expected fulfilment ${expect.fulfilment}, got ${actual ?? 'none'}`);
    }
  }

  return failures;
}

export function formatTextRehearsalTranscript(lines: string[]): string {
  return lines.join('\n');
}
