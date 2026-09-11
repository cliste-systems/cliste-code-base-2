import type { voice } from '@livekit/agents';

import { countAssistantTranscriptChars, estimateCallCostUsd } from './call_cost_estimate.js';
import { insertCallLog, updateCallLogEnrichment } from './call_logs.js';
import { postprocessCallTranscript } from './call_postprocess.js';
import type { CaraAgentUserData } from './cara_tools.js';
import { waitForSessionPlayout } from './end_call.js';
import { redactPii } from './gdpr.js';
import { mirrorLatestCall } from './sync_latest_call_transcript.js';
import {
  canonicalCallOutcome,
  postCallComplete,
  voiceWebhooksConfigured,
} from './voice_api.js';
import { finishUsageRecord } from './usage.js';

const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_TOOL_SNIPPET_CHARS = 800;

export type TranscriptLine = { at: number; seq: number; line: string };

export function truncateForTranscript(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 24))}… [truncated]`;
}

export function mergeTranscriptLines(parts: TranscriptLine[]): string | null {
  if (parts.length === 0) return null;
  const sorted = [...parts].sort((a, b) => a.at - b.at || a.seq - b.seq);
  let text = sorted.map((p) => p.line).join('\n\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[Transcript truncated for storage.]`;
  }
  return text;
}

export type FinalizeCallSessionInput = {
  session: voice.AgentSession<CaraAgentUserData>;
  transcriptParts: TranscriptLine[];
  callStartedAt: number;
  callerNumberRaw: string;
  livekitJobId: string | null;
  orgName: string;
  orgPhone: string | null;
  calledNumber: string;
  callSidAttr: string;
  roomName: string;
  inferenceLlmModel: string;
  inferenceSttModel: string;
  elevenModel: string;
  usageRecordIdPromise: Promise<string | null>;
  businessHours?: unknown;
};

export async function finalizeCallSession(input: FinalizeCallSessionInput): Promise<void> {
  const {
    session,
    transcriptParts,
    callStartedAt,
    callerNumberRaw,
    livekitJobId,
    orgName,
    orgPhone,
    calledNumber,
    callSidAttr,
    roomName,
    inferenceLlmModel,
    inferenceSttModel,
    elevenModel,
    usageRecordIdPromise,
  } = input;

  const ud = session.userData;
  if (!ud?.organizationId) return;

  const transcriptFlushMs = Number.parseInt(process.env.LIVEKIT_TRANSCRIPT_FLUSH_MS ?? '300', 10);
  await waitForSessionPlayout(session);
  if (Number.isFinite(transcriptFlushMs) && transcriptFlushMs > 0) {
    await new Promise((r) => setTimeout(r, Math.min(transcriptFlushMs, 2000)));
  }

  const durationSeconds = Math.max(0, Math.round((Date.now() - callStartedAt) / 1000));
  const outcome = canonicalCallOutcome({
    linkSent: ud.sessionFlags.linkSent,
    actionTicketCreated: ud.sessionFlags.actionTicketCreated,
    callbackRequested: ud.sessionFlags.callbackRequested,
    endPhoneCallUsed: ud.sessionFlags.endPhoneCallUsed,
  });

  const verbatimRaw = mergeTranscriptLines(transcriptParts);
  const verbatim = verbatimRaw ? redactPii(verbatimRaw) : null;
  const persistCalledNumber = calledNumber.trim() || orgPhone?.trim() || '';
  const mirrorBase = {
    callerNumber: callerNumberRaw,
    startedAtMs: callStartedAt,
    jobId: livekitJobId,
    orgName,
  };

  mirrorLatestCall({
    ...mirrorBase,
    callLogId: null,
    durationSeconds,
    outcome,
    transcript: verbatim,
    aiSummary: null,
  });

  let callLogId: string | null = null;
  let aiSummary: string | null = null;
  const webhookNotes: string[] = [];

  const initialPayload = {
    called_number: persistCalledNumber,
    call_sid: callSidAttr,
    room_name: roomName || null,
    caller_number: callerNumberRaw,
    duration_seconds: durationSeconds,
    outcome,
    transcript: verbatim,
    transcript_review: null as string | null,
    ai_summary: null as string | null,
    disclosure_confirmed: ud.disclosureConfirmed,
  };

        if (voiceWebhooksConfigured() && persistCalledNumber) {
          let webhookResult = await postCallComplete(initialPayload);
          if ((!webhookResult.ok || !webhookResult.callLogId) && durationSeconds >= 60) {
            await new Promise((r) => setTimeout(r, 2000));
            webhookResult = await postCallComplete(initialPayload);
          }
          if (webhookResult.ok && webhookResult.callLogId) {
            callLogId = webhookResult.callLogId;
            webhookNotes.push(`call-complete ok → call_log_id ${callLogId}`);
          } else {
            callLogId = await insertCallLog({
              organizationId: ud.organizationId,
              callerNumber: callerNumberRaw,
              durationSeconds,
              outcome,
              transcript: verbatim,
              calledNumber: persistCalledNumber || null,
              isTestCall: false,
              callSid: callSidAttr,
              roomName: roomName || null,
            });
            webhookNotes.push(`insertCallLog fallback → ${callLogId ?? 'failed'}`);
          }
        } else {
          callLogId = await insertCallLog({
            organizationId: ud.organizationId,
            callerNumber: callerNumberRaw,
            durationSeconds,
            outcome,
            transcript: verbatim,
            calledNumber: persistCalledNumber || null,
            isTestCall: false,
            callSid: callSidAttr,
            roomName: roomName || null,
          });
          webhookNotes.push(`direct insertCallLog → ${callLogId ?? 'failed'}`);
        }

  console.info('[agent] call_log_persisted', {
    id: callLogId,
    durationSeconds,
    outcome,
    transcriptLines: transcriptParts.length,
  });

  let transcriptReview: string | null = null;
  let didPostprocess = false;
  let knowledgeGaps: Array<{
    topic: string;
    caller_context?: string;
    cara_question?: string;
    suggested_section?: string;
  }> = [];

  if (verbatim) {
    const pp = await postprocessCallTranscript({
      verbatim,
      businessName: orgName,
      outcome,
      inferenceLlmModel,
      actionTicketCreated: ud.sessionFlags.actionTicketCreated,
      businessHours: input.businessHours,
    });
    transcriptReview = pp.transcriptReview ? redactPii(pp.transcriptReview) : null;
    aiSummary = pp.aiSummary ? redactPii(pp.aiSummary) : null;
    knowledgeGaps = pp.knowledgeGaps;
    didPostprocess = true;
  }

  const costEstimate = estimateCallCostUsd({
    durationSeconds,
    smsSegmentsSent: ud.sessionFlags.smsSent,
    didPostprocess,
    transcriptChars: verbatim?.length ?? 0,
    assistantTranscriptChars: verbatim ? countAssistantTranscriptChars(verbatim) : 0,
    sttModel: inferenceSttModel,
    llmModel: inferenceLlmModel,
    ttsModel: elevenModel,
  });

  if (callLogId && (transcriptReview || aiSummary || costEstimate)) {
    await updateCallLogEnrichment(callLogId, {
      transcriptReview,
      aiSummary,
      costEstimate,
    });
  }

  if (
    callLogId &&
    knowledgeGaps.length > 0 &&
    voiceWebhooksConfigured() &&
    persistCalledNumber
  ) {
    await postCallComplete({
      called_number: persistCalledNumber,
      call_sid: callSidAttr,
      room_name: roomName || null,
      caller_number: callerNumberRaw,
      duration_seconds: durationSeconds,
      outcome,
      knowledge_gaps: knowledgeGaps,
    });
  }

  const usageRecordId = await usageRecordIdPromise;
  if (usageRecordId) {
    await finishUsageRecord({ usageId: usageRecordId, durationSeconds });
  }

  mirrorLatestCall({
    ...mirrorBase,
    callLogId,
    durationSeconds,
    outcome,
    transcript: verbatim,
    aiSummary,
  });
}

export const TOOL_TRANSCRIPT_SNIPPET_MAX = MAX_TOOL_SNIPPET_CHARS;
