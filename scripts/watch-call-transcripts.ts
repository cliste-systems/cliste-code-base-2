#!/usr/bin/env npx tsx
/**
 * Poll Supabase for new call_logs and refresh call-transcripts/latest.md.
 * Run during phone testing so prod (Railway) calls appear locally without manual export.
 */
import 'dotenv/config';

import {
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

  let lastId: string | null = null;
  console.info('[watch:call-transcripts] polling every', pollMs, 'ms');

  const tick = async () => {
    try {
      const row = await fetchLatestCallRow(sb);
      if (!row) return;
      if (row.id !== lastId) {
        lastId = row.id;
        const path = mirrorLatestCall(rowToMirrorInput(row));
        console.info('[watch:call-transcripts] updated', row.id, path);
      }
    } catch (e) {
      console.error('[watch:call-transcripts] poll failed', e);
    }
  };

  await tick();
  setInterval(() => void tick(), pollMs);
}

void main();
