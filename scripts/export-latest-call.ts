#!/usr/bin/env npx tsx
/**
 * Pull the latest complete call_logs row from Supabase into call-transcripts/latest.md.
 *
 * Usage:
 *   npm run export:latest-call              # latest complete row (no wait)
 *   npm run export:latest-call -- --wait    # wait for new call after you hang up
 *   npm run export:latest-call -- --latest  # same as default (no min-created filter)
 */
import 'dotenv/config';

import {
  exportWaitOptionsFromArgv,
  syncLatestCallFromSupabase,
} from '../src/lib/sync_latest_call_transcript.js';

async function main() {
  const options = exportWaitOptionsFromArgv();
  const result = await syncLatestCallFromSupabase(undefined, options);

  if (result.status === 'written' && result.path) {
    const c = result.completeness;
    console.log(
      `Wrote ${result.path} (${c?.callerLineCount ?? 0} caller / ${c?.assistantLineCount ?? 0} assistant lines)`,
    );
    return;
  }

  if (result.status === 'incomplete') {
    console.error(
      'Latest call in Supabase is incomplete — not writing latest.md.',
      result.completeness?.reasons,
    );
    console.error('After a phone test, run: npm run export:latest-call -- --wait');
    process.exit(1);
  }

  if (result.status === 'timeout') {
    console.error(
      'Timed out waiting for a complete call_logs row in Supabase.',
      result.completeness?.reasons,
    );
    console.error('Check Railway logs for call-complete / insertCallLog failures.');
    process.exit(1);
  }

  process.exit(1);
}

void main();
