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

function buildMarkdown(input: CallTranscriptMirrorInput): string {
  const when = new Date(input.startedAtMs).toISOString();
  const org = input.orgName?.trim() || 'Cara call';
  return `# Latest Cara call — ${org}

| Field | Value |
|-------|-------|
| Time (UTC) | ${when} |
| Duration | ${input.durationSeconds}s |
| Outcome | ${input.outcome} |
| Caller | ${input.callerNumber} |
| Call log ID | ${input.callLogId ?? '(pending)'} |
| Job ID | ${input.jobId ?? '(unknown)'} |

## AI summary

${input.aiSummary?.trim() || '(none yet)'}

## Verbatim transcript

\`\`\`
${input.transcript?.trim() || '(empty)'}
\`\`\`
`;
}

/** Write latest call transcript to workspace for local / agent review (not for git). */
export function mirrorCallTranscriptToWorkspace(input: CallTranscriptMirrorInput): string | null {
  const dir = process.env.CARA_TRANSCRIPT_MIRROR_DIR?.trim() || join(process.cwd(), 'call-transcripts');
  try {
    mkdirSync(dir, { recursive: true });
    const body = buildMarkdown(input);
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
