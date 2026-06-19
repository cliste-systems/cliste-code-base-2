import type { CallCostEstimateRecord } from './call_cost_estimate.js';
import { redactPii } from './gdpr.js';
import { getSupabaseClient } from './supabase.js';

function directDbFallbackAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export async function insertCallLog(input: {
  organizationId: string;
  callerNumber: string;
  durationSeconds: number;
  outcome: string;
  transcript?: string | null;
  transcriptReview?: string | null;
  aiSummary?: string | null;
  costEstimate?: CallCostEstimateRecord | null;
}): Promise<string | null> {
  if (!directDbFallbackAllowed()) {
    console.error(
      '[call_logs] CRITICAL: direct insert blocked in production — configure CLISTE_APP_URL + CLISTE_VOICE_WEBHOOK_SECRET',
    );
    return null;
  }

  const supabase = getSupabaseClient();
  const transcript = input.transcript ? redactPii(input.transcript) : null;
  const transcriptReview = input.transcriptReview ? redactPii(input.transcriptReview) : null;
  const aiSummary = input.aiSummary ? redactPii(input.aiSummary) : null;
  const { data, error } = await supabase
    .from('call_logs')
    .insert({
      organization_id: input.organizationId,
      caller_number: input.callerNumber,
      duration_seconds: input.durationSeconds,
      outcome: input.outcome,
      transcript,
      transcript_review: transcriptReview,
      ai_summary: aiSummary,
      cost_estimate: input.costEstimate ?? null,
    })
    .select('id')
    .single();
  if (error) {
    console.error('insertCallLog failed', error);
    return null;
  }
  return typeof data?.id === 'string' ? data.id : null;
}
