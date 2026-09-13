import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CallCostEstimateRecord } from './call_cost_estimate.js';
import type { PostprocessKnowledgeGap } from './call_postprocess.js';
import type { TranscriptCompleteness } from './transcript_completeness.js';
import { assistantAskedWindDown } from './natural_phrasing.js';

export type CallDiagnosticLevel = 'info' | 'warn' | 'error';

export type CallDiagnosticEvent = {
  atMs: number;
  level: CallDiagnosticLevel;
  tag: string;
  message: string;
  data?: Record<string, unknown>;
};

export type CallPipelineSnapshot = {
  stt: string;
  sttKeytermCount?: number;
  sttNeuralTurn?: boolean;
  latencyProfile?: string;
  llm: string;
  tts: string;
  endpointMinMs?: number;
  endpointMaxMs?: number;
};

export type CallIdentifiers = {
  organizationId?: string | null;
  roomName?: string | null;
  callSid?: string | null;
  livekitJobId?: string | null;
  calledNumber?: string | null;
  disclosureConfirmed?: boolean;
};

export type CallDiagnosticBundle = {
  mirroredAtMs: number;
  deploy: Record<string, string | undefined>;
  identifiers: CallIdentifiers;
  pipeline?: CallPipelineSnapshot;
  sessionFlags?: Record<string, unknown>;
  transcriptCompleteness?: TranscriptCompleteness;
  transcriptReview?: string | null;
  costEstimate?: CallCostEstimateRecord | null;
  knowledgeGaps?: PostprocessKnowledgeGap[];
  postprocessRan?: boolean;
  webhookNotes?: string[];
  toolLines?: string[];
  events: CallDiagnosticEvent[];
  transcriptIssues: string[];
  recommendedChecks: string[];
  diagnosticContextMarkdown?: string;
  railwayLogs?: string | null;
  railwayLogsNote?: string;
  supabaseDeepLink?: string;
};

const MAX_EVENTS = 300;

export type CallDiagnosticSession = {
  push: (level: CallDiagnosticLevel, tag: string, data?: Record<string, unknown>) => void;
  setPipeline: (pipeline: CallPipelineSnapshot) => void;
  setIdentifiers: (ids: CallIdentifiers) => void;
  events: () => CallDiagnosticEvent[];
  getPipeline: () => CallPipelineSnapshot | undefined;
  getIdentifiers: () => CallIdentifiers;
};

export function createCallDiagnosticSession(): CallDiagnosticSession {
  const events: CallDiagnosticEvent[] = [];
  let pipeline: CallPipelineSnapshot | undefined;
  let identifiers: CallIdentifiers = {};

  const push = (level: CallDiagnosticLevel, tag: string, data?: Record<string, unknown>) => {
    const entry: CallDiagnosticEvent = {
      atMs: Date.now(),
      level,
      tag,
      message: tag,
      ...(data ? { data } : {}),
    };
    events.push(entry);
    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }
    const logFn =
      level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    logFn(`[agent] ${tag}`, data ?? '');
  };

  return {
    push,
    setPipeline: (p) => {
      pipeline = p;
    },
    setIdentifiers: (ids) => {
      identifiers = { ...identifiers, ...ids };
    },
    events: () => [...events],
    getPipeline: () => pipeline,
    getIdentifiers: () => identifiers,
  };
}

export function readDiagnosticContextFile(): string | undefined {
  const explicit = process.env.CARA_DIAGNOSTIC_CONTEXT_PATH?.trim();
  const candidates = [
    explicit,
    join(process.cwd(), 'call-transcripts', 'DIAGNOSTIC_CONTEXT.md'),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf8').trim();
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

export function buildDeployContext(): Record<string, string | undefined> {
  return {
    gitCommit:
      process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
      process.env.GIT_COMMIT?.trim() ||
      process.env.VERCEL_GIT_COMMIT_SHA?.trim(),
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID?.trim(),
    environment: process.env.RAILWAY_ENVIRONMENT?.trim() || process.env.NODE_ENV?.trim(),
    serviceName: process.env.RAILWAY_SERVICE_NAME?.trim(),
    projectId: process.env.RAILWAY_PROJECT_ID?.trim(),
    nodeVersion: process.version,
    workerRegion: process.env.LIVEKIT_WORKER_REGION?.trim(),
  };
}

export function extractToolLinesFromTranscript(transcript: string | null | undefined): string[] {
  const text = transcript?.trim() ?? '';
  if (!text) return [];
  return text
    .split('\n')
    .filter((line) => /^\[Tool/.test(line.trim()))
    .slice(-40);
}

export function analyzeTranscriptForIssues(
  transcript: string | null | undefined,
  opts?: {
    isTestCall?: boolean;
    demoScenarioSlug?: string | null;
  },
): string[] {
  const issues: string[] = [];
  const text = transcript?.trim() ?? '';
  if (!text) {
    issues.push('Transcript empty — check STT / mirror timing.');
    return issues;
  }

  const assistantLines = text.match(/^Assistant: .+$/gm) ?? [];
  const callerLines = text.match(/^Caller: .+$/gm) ?? [];
  const windDownCount = assistantLines.filter((l) =>
    assistantAskedWindDown(l.replace(/^Assistant:\s*/, '')),
  ).length;
  if (windDownCount > 1) {
    issues.push(
      `Robotic wind-down: wind-down check-in appeared ${windDownCount} times in assistant lines.`,
    );
  }
  if (windDownCount === 1 && assistantLines.length <= 4) {
    issues.push('Wind-down asked very early — check allowWindDown / mid-call Q&A.');
  }

  const goodbyePattern =
    /\b(take care|have a good one|talk soon|thanks for calling|thanks for ringing|have a (good|lovely) day)\b/i;
  const hasGoodbye = assistantLines.some((l) => goodbyePattern.test(l));
  const endedWithTool = /\bendPhoneCall\b/.test(text);
  if (endedWithTool && !hasGoodbye) {
    issues.push('endPhoneCall used but no warm goodbye detected in assistant speech.');
  }
  if (callerLines.length === 0) {
    issues.push('No caller lines — partial STT or transcript flush issue.');
  }

  const duplicateAssistant = new Set<string>();
  for (const line of assistantLines) {
    const norm = line.replace(/\s+/g, ' ').trim().toLowerCase();
    if (duplicateAssistant.has(norm)) {
      issues.push(`Duplicate assistant line detected: "${line.slice(0, 80)}…"`);
      break;
    }
    duplicateAssistant.add(norm);
  }

  const greetingLike = assistantLines.filter((l) => {
    const body = l.replace(/^Assistant:\s*/, '');
    return /thanks for (calling|ringing)|how can i help/i.test(body);
  });
  if (greetingLike.length > 1) {
    issues.push(`Duplicate greeting detected (${greetingLike.length} similar opening lines).`);
  }

  if (
    assistantLines.some((l) =>
      /\b(take your name|your name and number|name and number)\b/i.test(l),
    )
  ) {
    issues.push('Assistant asked for caller name/number — verify this was a callback, not simple Q&A.');
  }

  if (assistantLines.some((l) => /\bbye\b[.!?]?\s*$/i.test(l.replace(/^Assistant:\s*/, '')))) {
    issues.push('Bare "bye" closing detected — prefer warm thanks-for-calling + take care.');
  }

  if (/\[Tool error\]/m.test(text)) {
    issues.push('Tool errors present in transcript — inspect [Tool error] lines.');
  }

  const cutOffReplies = assistantLines.filter((l) => /\[cut off\]\s*$/i.test(l.trim()));
  if (cutOffReplies.length > 0 && callerLines.length > 0) {
    issues.push(
      `Assistant speech cut off ${cutOffReplies.length} time(s) — caller likely heard silence, not a full reply.`,
    );
  }

  const postGreetingAssistant = assistantLines.slice(1);
  if (
    callerLines.length >= 1 &&
    postGreetingAssistant.length >= 1 &&
    postGreetingAssistant.every((l) => /\[cut off\]\s*$/i.test(l.trim()))
  ) {
    issues.push(
      'Every post-greeting assistant line was cut off — treat as Cara silent on the phone.',
    );
  }

  if (opts?.isTestCall) {
    issues.push(...analyzeDemoCallTranscriptIssues(text, assistantLines, callerLines, opts));
  }

  return issues;
}

const DEMO_ROLEPLAY_INVITE =
  /\b(pretend|go ahead|play the customer|role-play|quick example|try a quick|walk you through)\b/i;

function looksLikeBulletListSpeech(body: string): boolean {
  if (/\b\d+\.\s/.test(body)) return true;
  if ((body.match(/\s[-–—]\s/g) ?? []).length >= 2) return true;
  if (/^\s*[-•*]\s/m.test(body)) return true;
  if (/\b(electrician|shop|mechanic|shop|garage)\b.*,\s.*\b(or|and)\b/i.test(body)) {
    return true;
  }
  return false;
}

function analyzeDemoCallTranscriptIssues(
  text: string,
  assistantLines: string[],
  callerLines: string[],
  opts: { demoScenarioSlug?: string | null },
): string[] {
  const issues: string[] = [];
  const slug = opts.demoScenarioSlug?.trim() || null;

  for (const line of assistantLines) {
    const body = line.replace(/^Assistant:\s*/, '');
    if (looksLikeBulletListSpeech(body)) {
      issues.push('Demo call: assistant turn looks like a bullet list — keep one short sentence.');
      break;
    }
  }

  if (assistantLines.some((l) => /\b(patricia|brendan)\b/i.test(l.replace(/^Assistant:\s*/, '')))) {
    issues.push('Demo call: assistant may have invented a caller name.');
  }

  const inviteIdx = assistantLines.findIndex((l) =>
    DEMO_ROLEPLAY_INVITE.test(l.replace(/^Assistant:\s*/, '')),
  );
  const tradeSlug = slug && slug !== 'general';

  if (tradeSlug) {
    if (inviteIdx < 0) {
      issues.push(`Demo trade (${slug}): missing role-play invitation in assistant speech.`);
    } else if (callerLines.length < 2 || assistantLines.length < 3) {
      issues.push(`Demo trade (${slug}): call may have ended before role-play completed.`);
    } else {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      let seenInvite = false;
      let callerAfterInvite = false;
      for (const line of lines) {
        if (
          !seenInvite &&
          line.startsWith('Assistant:') &&
          DEMO_ROLEPLAY_INVITE.test(line.replace(/^Assistant:\s*/, ''))
        ) {
          seenInvite = true;
          continue;
        }
        if (seenInvite && line.startsWith('Caller:')) {
          callerAfterInvite = true;
          break;
        }
      }
      if (!callerAfterInvite) {
        issues.push(`Demo trade (${slug}): no caller lines after role-play invite.`);
      }
    }
  }

  if (slug) {
    const wrapPattern =
      /\b(another (trade|example)|are you sorted|happy enough|sorted for now)\b/i;
    if (!assistantLines.some((l) => wrapPattern.test(l.replace(/^Assistant:\s*/, '')))) {
      issues.push(`Demo scenario (${slug}): missing wrap beat — offer another example or close.`);
    }
  }

  const endedWithTool = /\bendPhoneCall\b/.test(text);
  if (endedWithTool && callerLines.length <= 1 && assistantLines.length <= 2) {
    issues.push('Demo call: possible premature hangup — very few exchanges before endPhoneCall.');
  }

  return issues;
}

export function buildRecommendedChecks(input: {
  events: CallDiagnosticEvent[];
  transcriptIssues: string[];
  sessionFlags?: Record<string, unknown>;
}): string[] {
  const checks: string[] = [];
  const tags = new Set(input.events.map((e) => e.tag));

  if (tags.has('premature_anything_else')) {
    checks.push('Wind-down fired before linkSent/callback — verify allowWindDown and sessionFlags.');
  }
  if (tags.has('stale_speech_ignored')) {
    checks.push('Stale speech dropped — check replyTurnEpoch / turn coalescing (CALLER_BUMP_COALESCE_MS).');
  }
  if (tags.has('phantom_caller_transcript_ignored')) {
    checks.push('Phantom STT ignored — review dedupe and greeting phase timing.');
  }
  if (tags.has('caller_reply_recovery')) {
    checks.push('Caller reply recovery fired — agent may have been silent; check generateReply / pipeline.');
  }
  if (tags.has('sms_consent_pivot') || tags.has('link_qa_question')) {
    checks.push('SMS consent pivot/Q&A path — confirm callback intake in prompt + pivot handler.');
  }
  if (tags.has('call_complete_webhook_failed') || tags.has('call-complete webhook failed')) {
    checks.push('call-complete webhook failed — Supabase row may be missing enrichment; check voice webhook + Railway.');
  }
  if (input.sessionFlags?.endPhoneCallUsed && !input.sessionFlags?.closingCall) {
    checks.push('endPhoneCall without closingCall — goodbye may have been skipped.');
  }
  if (input.transcriptIssues.length > 0) {
    checks.push('Review transcript issues section and compare with agent events timeline.');
  }
  if (input.sessionFlags?.demoScenarioSlug) {
    checks.push(
      `Demo scenario ${String(input.sessionFlags.demoScenarioSlug)} — verify playbook beats in transcript.`,
    );
  }
  if (checks.length === 0) {
    checks.push('No automatic flags — read agent events + Railway logs for this window.');
  }
  return checks;
}

function formatJsonBlock(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatEventLine(ev: CallDiagnosticEvent, callStartMs?: number): string {
  const offset =
    callStartMs != null && Number.isFinite(callStartMs)
      ? `+${Math.max(0, ev.atMs - callStartMs)}ms`
      : new Date(ev.atMs).toISOString();
  const data =
    ev.data && Object.keys(ev.data).length > 0 ? ` ${formatJsonBlock(ev.data)}` : '';
  return `${offset} [${ev.level}] ${ev.tag}${data}`;
}

export function buildSupabaseRowDeepLink(
  callLogId: string | null | undefined,
  supabaseUrl?: string | null,
): string | undefined {
  const id = callLogId?.trim();
  const base = supabaseUrl?.trim() || process.env.SUPABASE_URL?.trim();
  if (!id || !base) return undefined;
  return `${base.replace(/\/$/, '')}/project/default/editor/table/call_logs?filter=id%3Aeq%3A${encodeURIComponent(id)}`;
}

export function buildCallDiagnosticBundle(input: {
  callStartedAtMs: number;
  identifiers?: CallIdentifiers;
  pipeline?: CallPipelineSnapshot;
  sessionFlags?: Record<string, unknown>;
  transcript?: string | null;
  transcriptCompleteness?: TranscriptCompleteness;
  transcriptReview?: string | null;
  costEstimate?: CallCostEstimateRecord | null;
  knowledgeGaps?: PostprocessKnowledgeGap[];
  postprocessRan?: boolean;
  webhookNotes?: string[];
  events?: CallDiagnosticEvent[];
  callLogId?: string | null;
  railwayLogs?: string | null;
  railwayLogsNote?: string;
}): CallDiagnosticBundle {
  const transcriptIssues = analyzeTranscriptForIssues(input.transcript);
  const events = input.events ?? [];
  const recommendedChecks = buildRecommendedChecks({
    events,
    transcriptIssues,
    ...(input.sessionFlags !== undefined ? { sessionFlags: input.sessionFlags } : {}),
  });
  const diagnosticContextMarkdown = readDiagnosticContextFile();
  const supabaseDeepLink = buildSupabaseRowDeepLink(input.callLogId);

  return {
    mirroredAtMs: Date.now(),
    deploy: buildDeployContext(),
    identifiers: input.identifiers ?? {},
    ...(input.pipeline !== undefined ? { pipeline: input.pipeline } : {}),
    ...(input.sessionFlags !== undefined ? { sessionFlags: input.sessionFlags } : {}),
    ...(input.transcriptCompleteness !== undefined
      ? { transcriptCompleteness: input.transcriptCompleteness }
      : {}),
    ...(input.transcriptReview !== undefined ? { transcriptReview: input.transcriptReview } : {}),
    ...(input.costEstimate !== undefined ? { costEstimate: input.costEstimate } : {}),
    ...(input.knowledgeGaps !== undefined ? { knowledgeGaps: input.knowledgeGaps } : {}),
    ...(input.postprocessRan !== undefined ? { postprocessRan: input.postprocessRan } : {}),
    ...(input.webhookNotes !== undefined ? { webhookNotes: input.webhookNotes } : {}),
    toolLines: extractToolLinesFromTranscript(input.transcript),
    events,
    transcriptIssues,
    recommendedChecks,
    ...(diagnosticContextMarkdown !== undefined
      ? { diagnosticContextMarkdown }
      : {}),
    ...(input.railwayLogs !== undefined ? { railwayLogs: input.railwayLogs } : {}),
    ...(input.railwayLogsNote !== undefined ? { railwayLogsNote: input.railwayLogsNote } : {}),
    ...(supabaseDeepLink !== undefined ? { supabaseDeepLink } : {}),
  };
}

export function formatDiagnosticMarkdown(
  bundle: CallDiagnosticBundle,
  callStartedAtMs?: number,
): string {
  const sections: string[] = [];

  sections.push('## Diagnostic bundle (for debugging)\n');
  sections.push(
    '_Auto-generated on mirror. Includes deploy context, session state, Supabase enrichment, agent events, and export-time Railway logs when available._\n',
  );

  sections.push('### Deploy & runtime\n');
  sections.push('| Key | Value |');
  sections.push('|-----|-------|');
  for (const [k, v] of Object.entries(bundle.deploy)) {
    sections.push(`| ${k} | ${v ?? '(unset)'} |`);
  }
  sections.push(`| mirroredAt | ${new Date(bundle.mirroredAtMs).toISOString()} |`);

  sections.push('\n### Call identifiers\n');
  sections.push('| Key | Value |');
  sections.push('|-----|-------|');
  for (const [k, v] of Object.entries(bundle.identifiers)) {
    sections.push(`| ${k} | ${String(v ?? '(unset)')} |`);
  }
  if (bundle.supabaseDeepLink) {
    sections.push(`| supabaseRow | ${bundle.supabaseDeepLink} |`);
  }

  if (bundle.pipeline) {
    sections.push('\n### Pipeline (STT / LLM / TTS)\n');
    sections.push('```json');
    sections.push(formatJsonBlock(bundle.pipeline));
    sections.push('```');
  }

  if (bundle.sessionFlags) {
    sections.push('\n### Session flags (end of call)\n');
    sections.push('```json');
    sections.push(formatJsonBlock(bundle.sessionFlags));
    sections.push('```');
  }

  if (bundle.transcriptCompleteness) {
    sections.push('\n### Transcript completeness\n');
    sections.push('```json');
    sections.push(formatJsonBlock(bundle.transcriptCompleteness));
    sections.push('```');
  }

  if (bundle.transcriptIssues.length > 0) {
    sections.push('\n### Transcript issues (heuristic)\n');
    for (const issue of bundle.transcriptIssues) {
      sections.push(`- ${issue}`);
    }
  }

  if (bundle.transcriptReview?.trim()) {
    sections.push('\n### Transcript review (postprocess LLM)\n');
    sections.push(bundle.transcriptReview.trim());
  }

  if (bundle.knowledgeGaps && bundle.knowledgeGaps.length > 0) {
    sections.push('\n### Knowledge gaps\n');
    sections.push('```json');
    sections.push(formatJsonBlock(bundle.knowledgeGaps));
    sections.push('```');
  }

  if (bundle.costEstimate) {
    sections.push('\n### Cost estimate (USD)\n');
    sections.push('```json');
    sections.push(formatJsonBlock(bundle.costEstimate));
    sections.push('```');
  }

  if (bundle.webhookNotes && bundle.webhookNotes.length > 0) {
    sections.push('\n### Webhook / persist notes\n');
    for (const note of bundle.webhookNotes) {
      sections.push(`- ${note}`);
    }
  }

  if (bundle.toolLines && bundle.toolLines.length > 0) {
    sections.push('\n### Tool calls (from transcript)\n');
    sections.push('```');
    sections.push(bundle.toolLines.join('\n'));
    sections.push('```');
  }

  if (bundle.events.length > 0) {
    sections.push('\n### Agent events (during call)\n');
    sections.push('```');
    for (const ev of bundle.events) {
      sections.push(formatEventLine(ev, callStartedAtMs));
    }
    sections.push('```');
  }

  sections.push('\n### Recommended checks\n');
  for (const check of bundle.recommendedChecks) {
    sections.push(`- ${check}`);
  }

  if (bundle.diagnosticContextMarkdown) {
    sections.push('\n### Active debugging notes (DIAGNOSTIC_CONTEXT.md)\n');
    sections.push(bundle.diagnosticContextMarkdown);
  }

  sections.push('\n### Railway logs\n');
  if (bundle.railwayLogs?.trim()) {
    sections.push('<details><summary>Exported Railway logs (call window)</summary>\n\n```');
    sections.push(bundle.railwayLogs.trim());
    sections.push('```\n\n</details>');
  } else {
    sections.push(
      bundle.railwayLogsNote?.trim() ||
        'No Railway logs bundled. From a linked project run:',
    );
    if (callStartedAtMs) {
      const since = new Date(callStartedAtMs - 120_000).toISOString();
      const until = new Date(callStartedAtMs + 600_000).toISOString();
      sections.push('\n```bash');
      sections.push(
        `railway logs --lines 400 --since ${since} --until ${until} --filter "[agent]"`,
      );
      sections.push('```');
    }
  }

  return sections.join('\n');
}
