#!/usr/bin/env npx tsx
/**
 * Export all call_logs from today (UTC) into call-transcripts/YYYY-MM-DD.md + archives.
 */
import 'dotenv/config';

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { assessTranscriptCompleteness } from '../src/lib/transcript_completeness.js';
import { mirrorCallTranscriptToWorkspace } from '../src/lib/call_transcript_mirror.js';
import {
  buildDiagnosticsForMirror,
  getSupabaseForTranscriptSync,
  rowToMirrorInput,
  type LatestCallRow,
} from '../src/lib/sync_latest_call_transcript.js';

const CALL_LOG_SELECT =
  'id,created_at,duration_seconds,outcome,transcript,ai_summary,caller_number,transcript_review,cost_estimate,organization_id';

async function main() {
  const sb = getSupabaseForTranscriptSync();
  if (!sb) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }

  const day = process.argv[2]?.trim() || new Date().toISOString().slice(0, 10);
  const start = `${day}T00:00:00.000Z`;
  const end = `${day}T23:59:59.999Z`;

  const { data, error } = await sb
    .from('call_logs')
    .select(CALL_LOG_SELECT)
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: true });

  if (error) {
    console.error(error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as LatestCallRow[];
  console.log(`Found ${rows.length} call(s) for ${day}`);

  const dir = process.env.CARA_TRANSCRIPT_MIRROR_DIR?.trim() || join(process.cwd(), 'call-transcripts');
  const dailyPath = join(dir, `${day}.md`);
  if (existsSync(dailyPath)) {
    unlinkSync(dailyPath);
  }

  let lastPath: string | null = null;
  for (const row of rows) {
    const completeness = assessTranscriptCompleteness(row.transcript);
    const input = rowToMirrorInput(row);
    const diagnostics = buildDiagnosticsForMirror(row, input, { fetchRailwayLogs: true });
    const path = mirrorCallTranscriptToWorkspace(
      { ...input, diagnostics },
      {
        partial: !completeness.complete,
        partialReasons: completeness.reasons,
      },
    );
    if (path) lastPath = path;
  }

  if (lastPath) {
    console.log(`Latest: ${lastPath}`);
    console.log(`Daily log: call-transcripts/${day}.md`);
  }
}

void main();
