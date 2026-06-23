#!/usr/bin/env npx tsx
/**
 * Poll Supabase for new call_logs and refresh call-transcripts/latest.md
 * once the persisted transcript includes real Caller lines.
 */
import 'dotenv/config';

import { assessTranscriptCompleteness } from '../src/lib/transcript_completeness.js';
import {
  fetchCallRowById,
  fetchLatestCallRow,
  getSupabaseForTranscriptSync,
  mirrorLatestCall,
  rowToMirrorInput,
} from '../src/lib/sync_latest_call_transcript.js';

const pollMs = Number.parseInt(process.env.CARA_TRANSCRIPT_POLL_MS ?? '15000', 10);

async function main() {
  const sb = getSupabaseForTranscriptSync();
  if (!sb) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  let lastWrittenId: string | null = null;
  let pendingId: string | null = null;
  console.info('[watch:call-transcripts] polling every', pollMs, 'ms');

  const tick = async () => {
    try {
      const row =
        pendingId != null
          ? await fetchCallRowById(sb, pendingId)
          : await fetchLatestCallRow(sb);

      if (!row) return;

      const completeness = assessTranscriptCompleteness(row.transcript);
      const isNew = row.id !== lastWrittenId;

      if (!isNew && pendingId == null) return;

      if (!completeness.complete) {
        pendingId = row.id;
        console.info('[watch:call-transcripts] waiting for complete transcript', {
          callLogId: row.id,
          reasons: completeness.reasons,
        });
        return;
      }

      pendingId = null;
      lastWrittenId = row.id;
      const path = mirrorLatestCall(rowToMirrorInput(row));
      console.info('[watch:call-transcripts] updated', row.id, path, {
        callerLines: completeness.callerLineCount,
        assistantLines: completeness.assistantLineCount,
      });
    } catch (e) {
      console.error('[watch:call-transcripts] poll failed', e);
    }
  };

  await tick();
  setInterval(() => void tick(), pollMs);
}

void main();
