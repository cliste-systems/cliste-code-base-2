import { llm } from '@livekit/agents';

import { parseBankHolidayConfig, parseBusinessHoursSchedule } from './business_hours.js';
import { createCaraLlm } from './llm_provider.js';
import { isCallerHeavyAssistantMissingTranscript } from './transcript_completeness.js';
import {
  callerSoundsLikeBankHolidayQuestion,
  callerSoundsLikeOpenHoursQuestion,
} from './retail_hours.js';
import {
  fallbackExtractPostCallActions,
  normalizePostCallActions,
  type PostCallAction,
} from './post_call_actions.js';
import { POST_CALL_ACTION_SUMMARY_GUIDANCE } from './intake_guidance.js';
import { stripToolLinesFromTranscript } from './transcript_display.js';

/** Avoid overwhelming inference context on very long calls. */
const MAX_VERBATIM_FOR_LLM = 48_000;

const POSTPROCESS_TIMEOUT_MS = Number.parseInt(
  process.env.CLISTE_CALL_POSTPROCESS_TIMEOUT_MS ?? '12000',
  10,
);

export type PostprocessKnowledgeGap = {
  topic: string;
  caller_context?: string;
  cara_question?: string;
  suggested_section?: string;
};

export type CallPostprocessResult = {
  transcriptReview: string;
  aiSummary: string;
  knowledgeGaps: PostprocessKnowledgeGap[];
  postCallActions: PostCallAction[];
  /** Post-call LLM judgment for owner dashboard badges. */
  callResolution: CallResolution | null;
};

export type CallResolution = 'resolved' | 'incomplete' | 'needs_follow_up';

export function normalizeCallResolution(value: unknown): CallResolution | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'resolved' || v === 'incomplete' || v === 'needs_follow_up') {
    return v;
  }
  return null;
}

function countTranscriptLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

function collectAssistantText(stream: AsyncIterable<{ delta?: { content?: string } }>): Promise<string> {
  return (async () => {
    let full = '';
    for await (const chunk of stream) {
      const c = chunk.delta?.content;
      if (typeof c === 'string' && c.length > 0) {
        full += c;
      }
    }
    return full;
  })();
}

export function parsePostprocessJsonPayload<T>(raw: string): T | null {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]!.trim() : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

const SUGGESTED_SECTIONS = new Set([
  'faq',
  'services',
  'services_not_offered',
  'business_rules',
]);

export function normalizePostprocessKnowledgeGaps(
  raw: unknown,
): PostprocessKnowledgeGap[] {
  if (!Array.isArray(raw)) return [];

  const out: PostprocessKnowledgeGap[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const topic = String((entry as { topic?: unknown }).topic ?? '').trim();
    if (!topic) continue;

    const callerContextRaw = String(
      (entry as { caller_context?: unknown }).caller_context ?? '',
    ).trim();
    const caraQuestionRaw = String(
      (entry as { cara_question?: unknown }).cara_question ?? '',
    ).trim();
    const suggestedRaw = String(
      (entry as { suggested_section?: unknown }).suggested_section ?? '',
    ).trim();

    const gap: PostprocessKnowledgeGap = { topic };
    if (callerContextRaw) gap.caller_context = callerContextRaw;
    if (caraQuestionRaw) gap.cara_question = caraQuestionRaw;
    if (suggestedRaw && SUGGESTED_SECTIONS.has(suggestedRaw)) {
      gap.suggested_section = suggestedRaw;
    }
    out.push(gap);
  }

  return out;
}

function orgHasStructuredBusinessHours(raw: unknown): boolean {
  if (raw == null) return false;
  if (parseBusinessHoursSchedule(raw)) return true;
  const bank = parseBankHolidayConfig(raw);
  return Boolean(bank?.configured);
}

function gapTextLooksLikeStructuredHours(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    callerSoundsLikeOpenHoursQuestion(t) || callerSoundsLikeBankHolidayQuestion(t)
  );
}

/** Drop hours/bank-holiday gaps when the org already has structured business_hours. */
export function filterKnowledgeGapsForStructuredHours(
  gaps: PostprocessKnowledgeGap[],
  businessHours: unknown,
): PostprocessKnowledgeGap[] {
  if (!orgHasStructuredBusinessHours(businessHours)) {
    return gaps;
  }
  return gaps.filter((gap) => {
    const combined = [gap.topic, gap.caller_context ?? ''].filter(Boolean).join(' ');
    return !gapTextLooksLikeStructuredHours(combined);
  });
}

function topicFromCallerQuestion(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/\bcoin machine|change machine|exchange coins|change for cash\b/i.test(t)) {
    return 'Coin machine / change for cash';
  }
  if (/\batm\b/i.test(t)) return 'ATM';
  const cleaned = t.replace(/\?+$/, '').trim();
  if (cleaned.length < 8) return null;
  return cleaned.slice(0, 120);
}

/** Programmatic safety net when post-call LLM omits teachable gaps. */
export function fallbackExtractKnowledgeGapsFromTranscript(
  verbatim: string,
): PostprocessKnowledgeGap[] {
  const lines = verbatim.split('\n').map((line) => line.trim()).filter(Boolean);
  const gaps: PostprocessKnowledgeGap[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]?.startsWith('Caller:')) continue;
    const callerText = lines[i]!.slice('Caller:'.length).trim();
    if (callerText.length < 8) continue;

    let assistantText = '';
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]?.startsWith('Assistant:')) {
        assistantText = lines[j]!.slice('Assistant:'.length).trim();
        break;
      }
      if (lines[j]?.startsWith('Caller:')) break;
    }
    if (
      !/\b(not too sure|not sure|don'?t know|can check|pass a message|check for you|i'?m unsure|offer to check)\b/i.test(
        assistantText,
      )
    ) {
      continue;
    }

    const topic = topicFromCallerQuestion(callerText);
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push({
      topic,
      caller_context: callerText.slice(0, 200),
      cara_question: `A caller asked about ${topic}. What should I tell them?`,
      suggested_section: 'faq',
    });
  }

  return gaps;
}

function mergeKnowledgeGaps(
  primary: PostprocessKnowledgeGap[],
  fallback: PostprocessKnowledgeGap[],
): PostprocessKnowledgeGap[] {
  const merged = [...primary];
  const seen = new Set(primary.map((gap) => gap.topic.trim().toLowerCase()));
  for (const gap of fallback) {
    const key = gap.topic.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(gap);
  }
  return merged.slice(0, 3);
}

function fallbackSummary(outcome: string): string {
  const o = outcome.toLowerCase();
  if (o.includes('link_sent')) {
    return 'The caller received a routing link by SMS during the call.';
  }
  if (o.includes('action_required') || o.includes('action_created')) {
    return 'Cara logged a follow-up for your team (Action Inbox).';
  }
  if (o.includes('callback')) {
    return 'The caller asked for a callback or transfer; the team was notified.';
  }
  if (o.includes('blocked')) {
    return 'The call was blocked by the business blocklist.';
  }
  if (o.includes('voicemail') || o.includes('no_speech')) {
    return 'The call connected, but the caller hung up right after Cara\'s greeting.';
  }
  return 'The caller spoke with Cara. See the transcript for details.';
}

/** Owner-facing summaries should say Cara — callers already heard AI disclosure in the greeting. */
export function sanitizeOwnerFacingCallSummary(summary: string): string {
  return summary
    .replace(/\bthe AI assistant's\b/gi, "Cara's")
    .replace(/\bthe AI assistant\b/gi, 'Cara')
    .replace(/\bAI assistant's\b/gi, "Cara's")
    .replace(/\bAI assistant\b/gi, 'Cara')
    .replace(/\bthe AI's\b/gi, "Cara's")
    .replace(/\bvirtual assistant's\b/gi, "Cara's")
    .replace(/\bvirtual assistant\b/gi, 'Cara');
}

async function runPostprocessLlm(input: {
  verbatimForLlm: string;
  businessName: string;
  outcome: string;
  inferenceLlmModel: string;
  conversationalRetailLine?: boolean;
  routesCatalog?: string;
}): Promise<CallPostprocessResult | null> {
  const { instance: postprocessLlm } = createCaraLlm({
    inferenceLlmModel: input.inferenceLlmModel,
    temperature: 0.25,
    maxCompletionTokens: 2200,
  });

  const postCallActionsBlock = input.conversationalRetailLine
    ? `
- postCallActions: Array (may be empty). Extract follow-up work Cara **completed verbally on the call** — nothing is logged live on 9508.
  Only include actions when intake clearly finished (caller gave name + details, or Cara verbally confirmed she logged it).
  **Do NOT** emit actions for opening-hours-only calls.
  Types:
  - {"type":"action_ticket","callerName":"first name they gave (or \\"Unknown caller\\" if they never said their name — caller ID is on file)","summary":"structured staff note (see below)","routeId":"best matching route id from catalog"}
  - {"type":"manager_callback","callerName":"first name","reason":"why they want the manager"}
  ${POST_CALL_ACTION_SUMMARY_GUIDANCE}
  Use caller names from the transcript only — never invent "caller" or placeholders.
  Infer routeId from the catalog when the errand clearly matches; omit if unclear.
${input.routesCatalog?.trim() ? `\nActive routes catalog:\n${input.routesCatalog.trim()}` : ''}`
    : '';

  const jsonKeys = input.conversationalRetailLine
    ? '"transcriptReview", "summary", "callResolution", "knowledgeGaps", and "postCallActions"'
    : '"transcriptReview", "summary", "callResolution", and "knowledgeGaps"';

  const userPrompt = `Business name: ${input.businessName}
Call outcome code: ${input.outcome}

VERBATIM TRANSCRIPT:
${input.verbatimForLlm}

Return ONLY valid JSON with keys ${jsonKeys} (no markdown outside JSON).
- transcriptReview: Full conversation with Caller: and Assistant: line prefixes only. Fix obvious speech-to-text mistakes. Include every caller and assistant turn — do not drop filler lines or omit lines. Do not include [Tool], [Tool result], or [Tool error] lines. Do not invent facts.
- summary: 2–4 short sentences in Irish/British English for the business owner: what the caller wanted, what happened, and the result. Say **Cara**, not "AI" or "AI assistant" — callers already heard that disclosure in the live greeting. For hang-ups after the opening only, e.g. "The caller hung up right after Cara's greeting."
- callResolution: exactly one of "resolved", "incomplete", "needs_follow_up" — judge from the full conversation:
  - resolved: the caller's question or errand was handled on the call (including simple hours/stock/directions answers with no further staff action).
  - incomplete: no shop errand was stated or completed — pleasantries only, abrupt hang-up, or the conversation never moved past small talk.
  - needs_follow_up: staff must still act (callback, order logged verbally, unresolved complaint, etc.).
- knowledgeGaps: Array (may be empty). Include an item when the caller asked about a service or topic Cara could not answer from the business menu/instructions, or Cara took a message because something was unlisted or unknown — **even if an Action Inbox ticket was also logged**. Each item: {"topic":"short label","caller_context":"optional staff excerpt","cara_question":"optional owner question","suggested_section":"faq|services|services_not_offered|business_rules"}. Omit payment/health/ID details. Do not emit gaps for opening hours, bank holidays, or St Patrick's Day when structured hours exist — those are handled programmatically. Do not duplicate routine booking/order/callback handoffs. Max 3 items.${postCallActionsBlock}`;

  const chatCtx = llm.ChatContext.empty();
  chatCtx.addMessage({
    role: 'user',
    content: userPrompt,
  });

  const stream = postprocessLlm.chat({ chatCtx });
  const raw = await collectAssistantText(stream);
  const parsed = parsePostprocessJsonPayload<{
    transcriptReview?: string;
    summary?: string;
    callResolution?: unknown;
    knowledgeGaps?: unknown;
    postCallActions?: unknown;
  }>(raw);
  if (parsed?.transcriptReview?.trim() && parsed?.summary?.trim()) {
    let postCallActions = input.conversationalRetailLine
      ? normalizePostCallActions(parsed.postCallActions)
      : [];
    if (input.conversationalRetailLine && postCallActions.length === 0) {
      postCallActions = fallbackExtractPostCallActions(input.verbatimForLlm);
    }
    return {
      transcriptReview: stripToolLinesFromTranscript(parsed.transcriptReview.trim()),
      aiSummary: sanitizeOwnerFacingCallSummary(parsed.summary.trim()),
      callResolution: normalizeCallResolution(parsed.callResolution),
      knowledgeGaps: normalizePostprocessKnowledgeGaps(parsed.knowledgeGaps),
      postCallActions,
    };
  }
  return null;
}

/**
 * Produces a readable transcript and short owner summary using LiveKit inference.
 */
export async function postprocessCallTranscript(input: {
  verbatim: string | null;
  businessName: string;
  outcome: string;
  inferenceLlmModel: string;
  actionTicketCreated?: boolean;
  businessHours?: unknown;
  conversationalRetailLine?: boolean;
  routesCatalog?: string;
}): Promise<CallPostprocessResult> {
  const verbatim = stripToolLinesFromTranscript(input.verbatim?.trim() ?? '');
  const emptyGaps: PostprocessKnowledgeGap[] = [];
  const emptyActions: PostCallAction[] = [];

  const verbatimForLlm =
    verbatim.length > MAX_VERBATIM_FOR_LLM
      ? `${verbatim.slice(0, MAX_VERBATIM_FOR_LLM)}\n\n[... truncated for AI processing ...]`
      : verbatim;

  if (!verbatim) {
    return {
      transcriptReview: '',
      aiSummary: '',
      callResolution: null,
      knowledgeGaps: emptyGaps,
      postCallActions: emptyActions,
    };
  }

  if (isCallerHeavyAssistantMissingTranscript(verbatim)) {
    const fallbackActions = input.conversationalRetailLine
      ? fallbackExtractPostCallActions(verbatim)
      : emptyActions;
    return {
      transcriptReview: verbatim,
      aiSummary: sanitizeOwnerFacingCallSummary(
        `${fallbackSummary(input.outcome)} Assistant lines missing from live capture — review verbatim only.`,
      ),
      callResolution: null,
      knowledgeGaps: emptyGaps,
      postCallActions: fallbackActions,
    };
  }

  const timeoutMs = Number.isFinite(POSTPROCESS_TIMEOUT_MS)
    ? Math.min(Math.max(POSTPROCESS_TIMEOUT_MS, 3000), 60_000)
    : 12_000;

  try {
    const result = await Promise.race([
      runPostprocessLlm({
        verbatimForLlm,
        businessName: input.businessName,
        outcome: input.outcome,
        inferenceLlmModel: input.inferenceLlmModel,
        ...(input.conversationalRetailLine !== undefined
          ? { conversationalRetailLine: input.conversationalRetailLine }
          : {}),
        ...(input.routesCatalog !== undefined ? { routesCatalog: input.routesCatalog } : {}),
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (result) {
      const verbatimLines = countTranscriptLines(verbatim);
      const reviewLines = countTranscriptLines(result.transcriptReview);
      let knowledgeGaps = mergeKnowledgeGaps(
        result.knowledgeGaps,
        fallbackExtractKnowledgeGapsFromTranscript(verbatim),
      );
      knowledgeGaps = filterKnowledgeGapsForStructuredHours(
        knowledgeGaps,
        input.businessHours,
      );
      let postCallActions = result.postCallActions;
      if (input.conversationalRetailLine && postCallActions.length === 0) {
        postCallActions = fallbackExtractPostCallActions(verbatim);
      }
      if (verbatimLines > 0 && reviewLines < Math.ceil(verbatimLines * 0.7)) {
        return {
          transcriptReview: verbatim,
          aiSummary: result.aiSummary,
          callResolution: result.callResolution,
          knowledgeGaps,
          postCallActions,
        };
      }
      return { ...result, knowledgeGaps, postCallActions };
    }
  } catch (e) {
    console.error('postprocessCallTranscript LLM failed', e);
  }

  const fallbackActions = input.conversationalRetailLine
    ? fallbackExtractPostCallActions(verbatim)
    : emptyActions;
  const fallbackGaps = fallbackExtractKnowledgeGapsFromTranscript(verbatim);

  return {
    transcriptReview: verbatim,
    aiSummary: sanitizeOwnerFacingCallSummary(fallbackSummary(input.outcome)),
    callResolution: null,
    knowledgeGaps: filterKnowledgeGapsForStructuredHours(
      fallbackGaps,
      input.businessHours,
    ),
    postCallActions: fallbackActions,
  };
}
