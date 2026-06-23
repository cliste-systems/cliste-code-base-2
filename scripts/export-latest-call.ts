#!/usr/bin/env npx tsx
/**
 * Pull the latest call_logs row from Supabase into call-transcripts/latest.md
 * and open it in the editor (for agent review without Supabase access).
 */
import 'dotenv/config';

import { syncLatestCallFromSupabase } from '../src/lib/sync_latest_call_transcript.js';

async function main() {
  const path = await syncLatestCallFromSupabase();
  if (!path) process.exit(1);
  console.log(`Wrote and opened ${path}`);
}

void main();
