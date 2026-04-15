import type { CallCostEstimateRecord } from './call_cost_estimate.js';
import { getSupabaseClient } from './supabase.js';

export async function insertCallLog(input: {
  organizationId: string;
  callerNumber: string;
  durationSeconds: number;
  outcome: string;
  /** Verbatim capture (STT + assistant text). */
  transcript?: string | null;
  /** Salon-friendly transcript with STT corrections. */
  transcriptReview?: string | null;
  /** Short owner-facing summary. */
  aiSummary?: string | null;
  /** Estimated infrastructure cost for /admin metrics (JSON). */
  costEstimate?: CallCostEstimateRecord | null;
}): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('call_logs')
    .insert({
      organization_id: input.organizationId,
      caller_number: input.callerNumber,
      duration_seconds: input.durationSeconds,
      outcome: input.outcome,
      transcript: input.transcript ?? null,
      transcript_review: input.transcriptReview ?? null,
      ai_summary: input.aiSummary ?? null,
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
