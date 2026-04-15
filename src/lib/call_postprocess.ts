import { inference, llm } from '@livekit/agents';

import type { SalonServiceRow } from './supabase.js';

import { applyDeterministicSalonTranscript } from './transcript_review.js';

/** Avoid overwhelming inference context on very long calls. */
const MAX_VERBATIM_FOR_LLM = 48_000;

export type CallPostprocessResult = {
  transcriptReview: string;
  aiSummary: string;
};

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
  if (o.includes('appointment_booked') || o.includes('booked')) {
    return 'The caller spoke with the AI receptionist; an appointment was booked or confirmed during the call.';
  }
  if (o.includes('link_sent')) {
    return 'The caller received a booking link by SMS during the call.';
  }
  if (o.includes('action_required') || o.includes('action required')) {
    return 'The AI logged a follow-up for your team (Action Inbox) — e.g. callback, named staff request, or topic outside the AI.';
  }
  if (o.includes('link')) {
    return 'The call included sending or discussing a booking link.';
  }
  return 'The caller spoke with the AI receptionist. See the transcript for details.';
}

/**
 * Produces a salon-friendly transcript (STT fixes) and a short owner summary using the same
 * LiveKit inference model as the voice agent.
 */
export async function postprocessCallTranscript(input: {
  verbatim: string | null;
  salonName: string;
  services: SalonServiceRow[];
  outcome: string;
  inferenceLlmModel: string;
}): Promise<CallPostprocessResult> {
  const verbatim = input.verbatim?.trim() ?? '';
  const deterministic = verbatim
    ? applyDeterministicSalonTranscript(verbatim, input.services)
    : '';

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

  const menu = input.services
    .map((s) => (typeof s.name === 'string' ? s.name.trim() : ''))
    .filter(Boolean)
    .join(', ');

  const postprocessLlm = new inference.LLM({
    model: input.inferenceLlmModel as inference.LLMModels,
    modelOptions: {
      temperature: 0.25,
      max_completion_tokens: 900,
    },
  });

  const userPrompt = `Salon name: ${input.salonName}
Services on the menu (use exact names when correcting STT): ${menu || '(none listed)'}
Call outcome code: ${input.outcome}

Deterministic wording pass already applied where obvious (below). Polish further if needed and match menu names.

VERBATIM TRANSCRIPT:
${verbatimForLlm}

DETERMINISTIC PRE-PASS (may still have errors):
${deterministic.length > MAX_VERBATIM_FOR_LLM ? `${deterministic.slice(0, MAX_VERBATIM_FOR_LLM)}…` : deterministic}

Return ONLY valid JSON with keys "transcriptReview" and "summary" (no markdown outside JSON).
- transcriptReview: Full conversation text with the same line prefixes as the verbatim (Caller:, Assistant:, [Tool], [Tool result], etc.). Fix speech-to-text mistakes using the menu (e.g. "feed" → "Fade" when Fade is a service and the caller is booking a haircut). Do not invent bookings or facts.
- summary: 2–4 short sentences in Irish/British English for the salon owner: what the caller wanted, what happened, and the result.`;

  const chatCtx = llm.ChatContext.empty();
  chatCtx.addMessage({
    role: 'user',
    content: userPrompt,
  });

  try {
    const stream = postprocessLlm.chat({ chatCtx });
    const raw = await collectAssistantText(stream);
    const parsed = parseJsonPayload<{ transcriptReview?: string; summary?: string }>(raw);
    if (parsed?.transcriptReview?.trim() && parsed?.summary?.trim()) {
      return {
        transcriptReview: parsed.transcriptReview.trim(),
        aiSummary: parsed.summary.trim(),
      };
    }
  } catch (e) {
    console.error('postprocessCallTranscript LLM failed', e);
  }

  return {
    transcriptReview: deterministic || verbatim,
    aiSummary: fallbackSummary(input.outcome),
  };
}
