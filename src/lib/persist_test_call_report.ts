import type { CallCloseDiagnosticsPayload } from './call_close_diagnostics.js';
import { getSupabaseClient, isOfflinePlayground } from './supabase.js';

export type PersistTestCallReportInput = {
  callLogId: string;
  organizationId: string;
  calledNumber: string;
  callerNumber: string;
  callSid?: string | null;
  roomName?: string | null;
  durationSeconds: number;
  disclosureConfirmed: boolean;
  testProfileId?: string | null;
  variantLabel?: string | null;
  diagnostics: CallCloseDiagnosticsPayload;
};

function countErrors(diagnostics: CallCloseDiagnosticsPayload): number {
  return diagnostics.events?.filter((e) => e.level === 'error').length ?? 0;
}

function hasEmptySpeechHandle(diagnostics: CallCloseDiagnosticsPayload): boolean {
  return (
    diagnostics.events?.some((e) => e.tag === 'empty_speech_handle') ?? false
  );
}

function computeHealth(input: {
  durationSeconds: number;
  diagnostics: CallCloseDiagnosticsPayload;
}): { status: 'pass' | 'degraded' | 'fail'; reason: string; needsReview: boolean } {
  const errors = countErrors(input.diagnostics);
  const emptySpeech = hasEmptySpeechHandle(input.diagnostics);
  const transcriptIssues = input.diagnostics.transcriptIssues ?? [];
  const callerLines = input.diagnostics.transcriptCompleteness?.callerLineCount ?? 0;
  const replyMsCount = input.diagnostics.latency?.replyMs?.length ?? 0;
  const silentReplyIssue = transcriptIssues.some(
    (i) => i.includes('cut off') || i.includes('Cara silent on the phone'),
  );

  if (silentReplyIssue) {
    return {
      status: 'fail',
      reason: 'Caller spoke but assistant replies were cut off — likely inaudible on the phone.',
      needsReview: true,
    };
  }
  if (
    callerLines >= 1 &&
    input.diagnostics.greetingPlayed &&
    replyMsCount === 0 &&
    transcriptIssues.some((i) => i.includes('cut off'))
  ) {
    return {
      status: 'fail',
      reason: 'No completed reply audio (replyMs empty) while caller spoke and speech was cut off.',
      needsReview: true,
    };
  }
  if (emptySpeech) {
    return {
      status: 'fail',
      reason: 'Assistant reply produced no audible speech (empty_speech_handle).',
      needsReview: true,
    };
  }
  if (errors > 0) {
    return {
      status: 'fail',
      reason: `${errors} pipeline error${errors === 1 ? '' : 's'} during the call.`,
      needsReview: true,
    };
  }
  if (!input.diagnostics.greetingPlayed) {
    return {
      status: 'fail',
      reason: 'Greeting did not play.',
      needsReview: true,
    };
  }
  if (input.durationSeconds < 3) {
    return {
      status: 'degraded',
      reason: 'Very short call — limited QA signal.',
      needsReview: true,
    };
  }
  return { status: 'pass', reason: 'Call completed without pipeline errors.', needsReview: false };
}

/** Write call_test_reports directly — do not rely on production call-complete webhook. */
export async function persistTestCallReportFromWorker(
  input: PersistTestCallReportInput,
): Promise<boolean> {
  if (isOfflinePlayground()) return false;

  const { status, reason, needsReview } = computeHealth({
    durationSeconds: input.durationSeconds,
    diagnostics: input.diagnostics,
  });

  const latency = input.diagnostics.latency ?? {};
  const pipelineSnapshot = input.diagnostics.pipeline ?? {};

  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('call_test_reports').upsert(
      {
        call_log_id: input.callLogId,
        organization_id: input.organizationId,
        test_profile_id: input.testProfileId?.trim() || null,
        variant_label: input.variantLabel?.trim() || null,
        called_number: input.calledNumber.trim() || null,
        caller_number: input.callerNumber.trim() || null,
        call_sid: input.callSid?.trim() || null,
        room_name: input.roomName?.trim() || null,
        health_status: status,
        health_reason: reason,
        latency,
        pipeline_snapshot: pipelineSnapshot,
        diagnostics: input.diagnostics,
        error_count: countErrors(input.diagnostics),
        greeting_played: input.diagnostics.greetingPlayed === true,
        disclosure_confirmed: input.disclosureConfirmed,
        duration_seconds: Math.max(0, input.durationSeconds),
        needs_review: needsReview,
      },
      { onConflict: 'call_log_id' },
    );

    if (error) {
      console.error('[test_call] persist report failed', error.message);
      return false;
    }

    await supabase
      .from('call_logs')
      .update({
        is_test_call: true,
        called_number: input.calledNumber.trim() || null,
      })
      .eq('id', input.callLogId);

    return true;
  } catch (err) {
    console.error('[test_call] persist report exception', err);
    return false;
  }
}
