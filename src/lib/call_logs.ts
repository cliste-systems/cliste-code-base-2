import type { CallCostEstimateRecord } from './call_cost_estimate.js';
import { redactPii } from './gdpr.js';
import { getSupabaseClient, isOfflinePlayground } from './supabase.js';

function directDbFallbackAllowed(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
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
  if (isOfflinePlayground()) return null;
  if (!directDbFallbackAllowed()) {
    console.error(
      '[call_logs] CRITICAL: direct insert blocked — set SUPABASE_SERVICE_ROLE_KEY or fix voice webhook',
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

export async function updateCallLogEnrichment(
  callLogId: string,
  input: {
    transcriptReview?: string | null;
    aiSummary?: string | null;
    costEstimate?: CallCostEstimateRecord | null;
  },
): Promise<boolean> {
  if (isOfflinePlayground()) return false;
  if (!directDbFallbackAllowed()) {
    console.error('[call_logs] CRITICAL: enrichment update blocked — no service role');
    return false;
  }
  const id = callLogId.trim();
  if (!id) return false;

  const patch: Record<string, unknown> = {};
  if (input.transcriptReview !== undefined) {
    patch.transcript_review = input.transcriptReview
      ? redactPii(input.transcriptReview)
      : null;
  }
  if (input.aiSummary !== undefined) {
    patch.ai_summary = input.aiSummary ? redactPii(input.aiSummary) : null;
  }
  if (input.costEstimate !== undefined) {
    patch.cost_estimate = input.costEstimate;
  }
  if (Object.keys(patch).length === 0) return true;

  const supabase = getSupabaseClient();
  const { error } = await supabase.from('call_logs').update(patch).eq('id', id);
  if (error) {
    console.error('updateCallLogEnrichment failed', error);
    return false;
  }
  return true;
}
