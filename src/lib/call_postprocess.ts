import { inference, llm } from '@livekit/agents';

/** Avoid overwhelming inference context on very long calls. */
const MAX_VERBATIM_FOR_LLM = 48_000;

const POSTPROCESS_TIMEOUT_MS = Number.parseInt(
  process.env.CLISTE_CALL_POSTPROCESS_TIMEOUT_MS ?? '12000',
  10,
);

export type CallPostprocessResult = {
  transcriptReview: string;
  aiSummary: string;
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

function parseJsonPayload<T>(raw: string): T | null {
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
      max_completion_tokens: 2000,
    },
  });

  const userPrompt = `Business name: ${input.businessName}
Call outcome code: ${input.outcome}

VERBATIM TRANSCRIPT:
${input.verbatimForLlm}

Return ONLY valid JSON with keys "transcriptReview" and "summary" (no markdown outside JSON).
- transcriptReview: Full conversation with the same line prefixes (Caller:, Assistant:, [Tool], etc.). Fix obvious speech-to-text mistakes. Include every turn and tool step — do not drop filler lines or omit lines. Do not invent facts.
- summary: 2–4 short sentences in Irish/British English for the business owner: what the caller wanted, what happened, and the result.`;

  const chatCtx = llm.ChatContext.empty();
  chatCtx.addMessage({
    role: 'user',
    content: userPrompt,
  });

  const stream = postprocessLlm.chat({ chatCtx });
  const raw = await collectAssistantText(stream);
  const parsed = parseJsonPayload<{ transcriptReview?: string; summary?: string }>(raw);
  if (parsed?.transcriptReview?.trim() && parsed?.summary?.trim()) {
    return {
      transcriptReview: parsed.transcriptReview.trim(),
      aiSummary: parsed.summary.trim(),
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
}): Promise<CallPostprocessResult> {
  const verbatim = input.verbatim?.trim() ?? '';

  const verbatimForLlm =
    verbatim.length > MAX_VERBATIM_FOR_LLM
      ? `${verbatim.slice(0, MAX_VERBATIM_FOR_LLM)}\n\n[... truncated for AI processing ...]`
      : verbatim;

  if (!verbatim) {
    return {
      transcriptReview: '',
      aiSummary: '',
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
      if (verbatimLines > 0 && reviewLines < Math.ceil(verbatimLines * 0.7)) {
        return {
          transcriptReview: verbatim,
          aiSummary: result.aiSummary,
        };
      }
      return result;
    }
  } catch (e) {
    console.error('postprocessCallTranscript LLM failed', e);
  }

  return {
    transcriptReview: verbatim,
    aiSummary: fallbackSummary(input.outcome),
  };
}
