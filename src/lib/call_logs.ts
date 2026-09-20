import type { CallCostEstimateRecord } from './call_cost_estimate.js';
import { redactPii } from './gdpr.js';
import type {
  PostCallErrorEntry,
  PostCallStatus,
} from './post_call_processing.js';
import { getSupabaseClient, isOfflinePlayground } from './supabase.js';
import { stripToolLinesFromTranscript } from './transcript_display.js';

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
  calledNumber?: string | null;
  isTestCall?: boolean;
  isEngineerTestCall?: boolean;
  callSid?: string | null;
  roomName?: string | null;
}): Promise<string | null> {
  if (isOfflinePlayground()) return null;
  if (!directDbFallbackAllowed()) {
    console.error(
      '[call_logs] CRITICAL: direct insert blocked — set SUPABASE_SERVICE_ROLE_KEY or fix voice webhook',
    );
    return null;
  }

  const supabase = getSupabaseClient();
  const transcriptRaw = input.transcript
    ? stripToolLinesFromTranscript(input.transcript)
    : null;
  const transcriptReviewRaw = input.transcriptReview
    ? stripToolLinesFromTranscript(input.transcriptReview)
    : null;
  const transcript = transcriptRaw ? redactPii(transcriptRaw) : null;
  const transcriptReview = transcriptReviewRaw ? redactPii(transcriptReviewRaw) : null;
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
      ...(input.calledNumber?.trim() ? { called_number: input.calledNumber.trim() } : {}),
      ...(input.isTestCall === true ? { is_test_call: true } : {}),
      ...(input.isEngineerTestCall === true ? { engineer_test_call: true } : {}),
      ...(input.callSid?.trim() ? { call_sid: input.callSid.trim() } : {}),
      ...(input.roomName?.trim() ? { room_name: input.roomName.trim() } : {}),
      post_call_status: 'pending',
      post_call_errors: [],
      post_call_expected_ticket: false,
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
    callResolution?: string | null;
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
      ? redactPii(stripToolLinesFromTranscript(input.transcriptReview))
      : null;
  }
  if (input.aiSummary !== undefined) {
    patch.ai_summary = input.aiSummary ? redactPii(input.aiSummary) : null;
  }
  if (input.costEstimate !== undefined) {
    patch.cost_estimate = input.costEstimate;
  }
  if (input.callResolution !== undefined) {
    patch.call_resolution = input.callResolution;
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

export async function updateCallLogOutcome(callLogId: string, outcome: string): Promise<boolean> {
  if (isOfflinePlayground()) return false;
  if (!directDbFallbackAllowed()) {
    console.error('[call_logs] CRITICAL: outcome update blocked — no service role');
    return false;
  }
  const id = callLogId.trim();
  if (!id || !outcome.trim()) return false;

  const supabase = getSupabaseClient();
  const { error } = await supabase.from('call_logs').update({ outcome: outcome.trim() }).eq('id', id);
  if (error) {
    console.error('updateCallLogOutcome failed', error);
    return false;
  }
  return true;
}

export async function updateCallLogAudioPath(
  callLogId: string,
  audioStoragePath: string,
): Promise<boolean> {
  if (isOfflinePlayground()) return false;
  if (!directDbFallbackAllowed()) {
    console.error('[call_logs] CRITICAL: audio path update blocked — no service role');
    return false;
  }
  const id = callLogId.trim();
  const path = audioStoragePath.trim();
  if (!id || !path) return false;

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('call_logs')
    .update({ audio_storage_path: path })
    .eq('id', id);
  if (error) {
    console.error('updateCallLogAudioPath failed', error);
    return false;
  }
  return true;
}

export async function updateCallLogPostCallProcessing(
  callLogId: string,
  input: {
    postCallStatus: PostCallStatus;
    postCallErrors?: PostCallErrorEntry[];
    postCallExpectedTicket?: boolean;
  },
): Promise<boolean> {
  if (isOfflinePlayground()) return false;
  if (!directDbFallbackAllowed()) {
    console.error('[call_logs] CRITICAL: post-call status update blocked — no service role');
    return false;
  }
  const id = callLogId.trim();
  if (!id) return false;

  const patch: Record<string, unknown> = {
    post_call_status: input.postCallStatus,
  };
  if (input.postCallErrors !== undefined) {
    patch.post_call_errors = input.postCallErrors;
  }
  if (input.postCallExpectedTicket !== undefined) {
    patch.post_call_expected_ticket = input.postCallExpectedTicket;
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase.from('call_logs').update(patch).eq('id', id);
  if (error) {
    console.error('updateCallLogPostCallProcessing failed', error);
    return false;
  }
  return true;
}
