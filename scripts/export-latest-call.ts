#!/usr/bin/env npx tsx
/**
 * Pull the latest call_logs row from Supabase into call-transcripts/latest.md
 * for local agent review (Claude cannot query Supabase directly).
 */
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';

import { mirrorCallTranscriptToWorkspace } from '../src/lib/call_transcript_mirror.js';

async function main() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  const sb = createClient(url, key);
  const { data, error } = await sb
    .from('call_logs')
    .select('id,created_at,duration_seconds,outcome,transcript,ai_summary,caller_number')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(error);
    process.exit(1);
  }
  if (!data) {
    console.error('No call logs found');
    process.exit(1);
  }

  const startedAtMs = Date.parse(data.created_at) - data.duration_seconds * 1000;
  const orgLabel = process.env.CARA_TRANSCRIPT_ORG_NAME?.trim();
  const path = mirrorCallTranscriptToWorkspace({
    callLogId: data.id,
    callerNumber: data.caller_number ?? '(unknown)',
    durationSeconds: data.duration_seconds ?? 0,
    outcome: data.outcome ?? 'unknown',
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
    transcript: data.transcript,
    aiSummary: data.ai_summary,
    ...(orgLabel ? { orgName: orgLabel } : {}),
  });

  console.log(path ? `Wrote ${path}` : 'Mirror failed');
}

void main();
