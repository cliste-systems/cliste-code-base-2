import type {
  CallDiagnosticEvent,
  CallIdentifiers,
  CallPipelineSnapshot,
} from './call_diagnostic_bundle.js';
import {
  analyzeTranscriptForIssues,
  buildDeployContext,
  buildRecommendedChecks,
  extractToolLinesFromTranscript,
} from './call_diagnostic_bundle.js';
import type { CallCostEstimateRecord } from './call_cost_estimate.js';
import { assessTranscriptCompleteness, type TranscriptCompleteness } from './transcript_completeness.js';

export type CallLatencySnapshot = {
  greetingMs?: number;
  timeToFirstAudioMs?: number;
  replyMs: number[];
  replyP50?: number;
  replyP95?: number;
  userSpeakingToThinkingMs: number[];
};

export type CallCloseDiagnosticsPayload = {
  latency: CallLatencySnapshot;
  pipeline?: CallPipelineSnapshot;
  sessionFlags?: Record<string, unknown>;
  events: CallDiagnosticEvent[];
  greetingPlayed: boolean;
  greetingSource?: 'cached_pcm' | 'live_tts' | null;
  disclosureConfirmed: boolean;
  deploy: Record<string, string | undefined>;
  transcriptIssues: string[];
  identifiers?: CallIdentifiers;
  orgSnapshot?: Record<string, unknown>;
  configSnapshot?: Record<string, unknown>;
  recommendedChecks?: string[];
  toolLines?: string[];
  transcriptCompleteness?: TranscriptCompleteness;
  costEstimate?: CallCostEstimateRecord | null;
  postprocessRan?: boolean;
  knowledgeGapCount?: number;
  greetingText?: string | null;
  capturedAtMs?: number;
};

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function createCallLatencyTracker(callStartedAtMs: number) {
  let greetingMs: number | undefined;
  let timeToFirstAudioMs: number | undefined;
  const replyMs: number[] = [];
  const userSpeakingToThinkingMs: number[] = [];

  return {
    recordGreetingPlayback() {
      if (greetingMs == null) {
        greetingMs = Math.max(0, Date.now() - callStartedAtMs);
      }
      if (timeToFirstAudioMs == null) {
        timeToFirstAudioMs = greetingMs;
      }
    },
    recordFirstAudio() {
      if (timeToFirstAudioMs == null) {
        timeToFirstAudioMs = Math.max(0, Date.now() - callStartedAtMs);
      }
    },
    recordReplyLatency(ms: number) {
      if (Number.isFinite(ms) && ms >= 0) replyMs.push(ms);
    },
    recordUserToThinking(ms: number) {
      if (Number.isFinite(ms) && ms >= 0) userSpeakingToThinkingMs.push(ms);
    },
    snapshot(): CallLatencySnapshot {
      const sorted = [...replyMs].sort((a, b) => a - b);
      const snapshot: CallLatencySnapshot = {
        replyMs,
        userSpeakingToThinkingMs,
      };
      if (greetingMs != null) snapshot.greetingMs = greetingMs;
      if (timeToFirstAudioMs != null) snapshot.timeToFirstAudioMs = timeToFirstAudioMs;
      const p50 = percentile(sorted, 50);
      const p95 = percentile(sorted, 95);
      if (p50 != null) snapshot.replyP50 = p50;
      if (p95 != null) snapshot.replyP95 = p95;
      return snapshot;
    },
  };
}

export function buildCloseDiagnosticsPayload(input: {
  latency: CallLatencySnapshot;
  pipeline?: CallPipelineSnapshot;
  sessionFlags?: Record<string, unknown>;
  events: CallDiagnosticEvent[];
  greetingPlayed: boolean;
  greetingSource?: 'cached_pcm' | 'live_tts' | null;
  disclosureConfirmed: boolean;
  transcript?: string | null;
  identifiers?: CallIdentifiers;
  orgSnapshot?: Record<string, unknown>;
  configSnapshot?: Record<string, unknown>;
  costEstimate?: CallCostEstimateRecord | null;
  postprocessRan?: boolean;
  knowledgeGapCount?: number;
  greetingText?: string | null;
  isTestCall?: boolean;
}): CallCloseDiagnosticsPayload {
  const demoScenarioSlug =
    typeof input.sessionFlags?.demoScenarioSlug === 'string'
      ? input.sessionFlags.demoScenarioSlug
      : null;
  const transcriptIssues = analyzeTranscriptForIssues(input.transcript, {
    isTestCall: input.isTestCall,
    demoScenarioSlug,
  });
  const recommendedChecks = buildRecommendedChecks({
    events: input.events,
    transcriptIssues,
    ...(input.sessionFlags !== undefined ? { sessionFlags: input.sessionFlags } : {}),
  });

  return {
    latency: input.latency,
    ...(input.pipeline !== undefined ? { pipeline: input.pipeline } : {}),
    ...(input.sessionFlags !== undefined ? { sessionFlags: input.sessionFlags } : {}),
    events: input.events,
    greetingPlayed: input.greetingPlayed,
    ...(input.greetingSource !== undefined ? { greetingSource: input.greetingSource } : {}),
    disclosureConfirmed: input.disclosureConfirmed,
    deploy: buildDeployContext(),
    transcriptIssues,
    ...(input.identifiers !== undefined ? { identifiers: input.identifiers } : {}),
    ...(input.orgSnapshot !== undefined ? { orgSnapshot: input.orgSnapshot } : {}),
    ...(input.configSnapshot !== undefined ? { configSnapshot: input.configSnapshot } : {}),
    recommendedChecks,
    toolLines: extractToolLinesFromTranscript(input.transcript),
    transcriptCompleteness: assessTranscriptCompleteness(input.transcript),
    ...(input.costEstimate !== undefined ? { costEstimate: input.costEstimate } : {}),
    ...(input.postprocessRan !== undefined ? { postprocessRan: input.postprocessRan } : {}),
    ...(input.knowledgeGapCount !== undefined
      ? { knowledgeGapCount: input.knowledgeGapCount }
      : {}),
    ...(input.greetingText !== undefined ? { greetingText: input.greetingText } : {}),
    capturedAtMs: Date.now(),
  };
}

export function countDiagnosticErrors(events: CallDiagnosticEvent[]): number {
  return events.filter((e) => e.level === 'error').length;
}
