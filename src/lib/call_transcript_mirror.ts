import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type CallTranscriptMirrorInput = {
  callLogId?: string | null;
  callerNumber: string;
  durationSeconds: number;
  outcome: string;
  startedAtMs: number;
  transcript: string | null;
  aiSummary?: string | null;
  jobId?: string | null;
  orgName?: string;
};

export type CallTranscriptMirrorOptions = {
  /** When true, prepend a warning banner and list missing pieces. */
  partial?: boolean;
  partialReasons?: string[];
};

function buildPartialBanner(reasons: string[]): string {
  const bullets = reasons.map((r) => `- ${r}`).join('\n');
  return `> ⚠️ **Partial transcript** — not safe for QA. Waiting for Supabase \`call_logs\` with real Caller lines.
>
> ${bullets.replace(/\n/g, '\n> ')}
>
> Re-run \`npm run export:latest-call -- --wait\` after the call is persisted.
`;
}

function buildMarkdown(
  input: CallTranscriptMirrorInput,
  options?: CallTranscriptMirrorOptions,
): string {
  const when = new Date(input.startedAtMs).toISOString();
  const org = input.orgName?.trim() || 'Cara call';
  const partialBanner =
    options?.partial && options.partialReasons?.length
      ? `${buildPartialBanner(options.partialReasons)}\n\n`
      : '';
  return `${partialBanner}# Latest Cara call — ${org}

| Field | Value |
|-------|-------|
| Time (UTC) | ${when} |
| Duration | ${input.durationSeconds}s |
| Outcome | ${input.outcome} |
| Caller | ${input.callerNumber} |
| Call log ID | ${input.callLogId ?? '(pending)'} |
| Job ID | ${input.jobId ?? '(unknown)'} |
| Transcript | ${options?.partial ? 'partial' : 'complete'} |

## AI summary

${input.aiSummary?.trim() || '(none yet)'}

## Verbatim transcript

\`\`\`
${input.transcript?.trim() || '(empty)'}
\`\`\`
`;
}

/** Write latest call transcript to workspace for local / agent review (not for git). */
export function mirrorCallTranscriptToWorkspace(
  input: CallTranscriptMirrorInput,
  options?: CallTranscriptMirrorOptions,
): string | null {
  const dir = process.env.CARA_TRANSCRIPT_MIRROR_DIR?.trim() || join(process.cwd(), 'call-transcripts');
  try {
    mkdirSync(dir, { recursive: true });
    const body = buildMarkdown(input, options);
    const latestPath = join(dir, 'latest.md');
    writeFileSync(latestPath, body, 'utf8');
    const archiveName = `${whenArchiveSlug(input.startedAtMs)}.md`;
    writeFileSync(join(dir, archiveName), body, 'utf8');
    console.info('[agent] transcript_mirrored', { path: latestPath, archive: archiveName });
    return latestPath;
  } catch (e) {
    console.error('[agent] transcript_mirror_failed', e);
    return null;
  }
}

function whenArchiveSlug(startedAtMs: number): string {
  return new Date(startedAtMs).toISOString().replace(/[:.]/g, '-');
}
