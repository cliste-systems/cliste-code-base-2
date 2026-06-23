import { inference, llm } from '@livekit/agents';

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
};

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
  input?: { actionTicketCreated?: boolean },
): PostprocessKnowledgeGap[] {
  if (input?.actionTicketCreated) {
    return [];
  }
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

function fallbackSummary(outcome: string): string {
  const o = outcome.toLowerCase();
  if (o.includes('link_sent')) {
    return 'The caller received a routing link by SMS during the call.';
  }
  if (o.includes('action_required') || o.includes('action_created')) {
    return 'The AI logged a follow-up for your team (Action Inbox).';
  }
  if (o.includes('callback')) {
    return 'The caller asked for a callback or transfer; the team was notified.';
  }
  if (o.includes('blocked')) {
    return 'The call was blocked by the business blocklist.';
  }
  return 'The caller spoke with Cara. See the transcript for details.';
}

async function runPostprocessLlm(input: {
  verbatimForLlm: string;
  businessName: string;
  outcome: string;
  inferenceLlmModel: string;
}): Promise<CallPostprocessResult | null> {
  const postprocessLlm = new inference.LLM({
    model: input.inferenceLlmModel as inference.LLMModels,
    modelOptions: {
      temperature: 0.25,
      max_completion_tokens: 2200,
    },
  });

  const userPrompt = `Business name: ${input.businessName}
Call outcome code: ${input.outcome}

VERBATIM TRANSCRIPT:
${input.verbatimForLlm}

Return ONLY valid JSON with keys "transcriptReview", "summary", and "knowledgeGaps" (no markdown outside JSON).
- transcriptReview: Full conversation with the same line prefixes (Caller:, Assistant:, [Tool], etc.). Fix obvious speech-to-text mistakes. Include every turn and tool step — do not drop filler lines or omit lines. Do not invent facts.
- summary: 2–4 short sentences in Irish/British English for the business owner: what the caller wanted, what happened, and the result.
- knowledgeGaps: Array (may be empty). Include an item when the caller asked about a service or topic Cara could not answer from the business menu/instructions, or Cara took a message because something was unlisted or unknown. Each item: {"topic":"short label","caller_context":"optional staff excerpt","cara_question":"optional owner question","suggested_section":"faq|services|services_not_offered|business_rules"}. Omit payment/health/ID details. Do not duplicate routine Action Inbox handoffs already covered by the outcome. Max 3 items.`;

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
    knowledgeGaps?: unknown;
  }>(raw);
  if (parsed?.transcriptReview?.trim() && parsed?.summary?.trim()) {
    return {
      transcriptReview: parsed.transcriptReview.trim(),
      aiSummary: parsed.summary.trim(),
      knowledgeGaps: normalizePostprocessKnowledgeGaps(parsed.knowledgeGaps),
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
}): Promise<CallPostprocessResult> {
  const verbatim = input.verbatim?.trim() ?? '';
  const emptyGaps: PostprocessKnowledgeGap[] = [];

  const verbatimForLlm =
    verbatim.length > MAX_VERBATIM_FOR_LLM
      ? `${verbatim.slice(0, MAX_VERBATIM_FOR_LLM)}\n\n[... truncated for AI processing ...]`
      : verbatim;

  if (!verbatim) {
    return {
      transcriptReview: '',
      aiSummary: '',
      knowledgeGaps: emptyGaps,
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
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (result) {
      const verbatimLines = countTranscriptLines(verbatim);
      const reviewLines = countTranscriptLines(result.transcriptReview);
      const knowledgeGaps = input.actionTicketCreated ? [] : result.knowledgeGaps;
      if (verbatimLines > 0 && reviewLines < Math.ceil(verbatimLines * 0.7)) {
        return {
          transcriptReview: verbatim,
          aiSummary: result.aiSummary,
          knowledgeGaps,
        };
      }
      return { ...result, knowledgeGaps };
    }
  } catch (e) {
    console.error('postprocessCallTranscript LLM failed', e);
  }

  return {
    transcriptReview: verbatim,
    aiSummary: fallbackSummary(input.outcome),
    knowledgeGaps: emptyGaps,
  };
}
