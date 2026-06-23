import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  mirrorCallTranscriptToWorkspace,
  type CallTranscriptMirrorInput,
} from './call_transcript_mirror.js';

export type LatestCallRow = {
  id: string;
  created_at: string;
  duration_seconds: number | null;
  outcome: string | null;
  transcript: string | null;
  ai_summary: string | null;
  caller_number: string | null;
};

export function rowToMirrorInput(
  row: LatestCallRow,
  extras?: { jobId?: string | null; orgName?: string },
): CallTranscriptMirrorInput {
  const durationSeconds = row.duration_seconds ?? 0;
  const startedAtMs =
    Date.parse(row.created_at) - durationSeconds * 1000;
  const orgLabel = extras?.orgName ?? process.env.CARA_TRANSCRIPT_ORG_NAME?.trim();
  return {
    callLogId: row.id,
    callerNumber: row.caller_number ?? '(unknown)',
    durationSeconds,
    outcome: row.outcome ?? 'unknown',
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
    transcript: row.transcript,
    aiSummary: row.ai_summary,
    jobId: extras?.jobId ?? null,
    ...(orgLabel ? { orgName: orgLabel } : {}),
  };
}

export function getSupabaseForTranscriptSync(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key);
}

export async function fetchLatestCallRow(
  sb: SupabaseClient,
): Promise<LatestCallRow | null> {
  const { data, error } = await sb
    .from('call_logs')
    .select('id,created_at,duration_seconds,outcome,transcript,ai_summary,caller_number')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Pull latest Supabase call_logs row into call-transcripts/latest.md */
export async function syncLatestCallFromSupabase(
  sb?: SupabaseClient,
): Promise<string | null> {
  const client = sb ?? getSupabaseForTranscriptSync();
  if (!client) {
    console.error('[transcript_sync] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    return null;
  }
  const row = await fetchLatestCallRow(client);
  if (!row) {
    console.error('[transcript_sync] no call_logs rows');
    return null;
  }
  return mirrorLatestCall(rowToMirrorInput(row));
}

export function mirrorLatestCall(input: CallTranscriptMirrorInput): string | null {
  const path = mirrorCallTranscriptToWorkspace(input);
  if (path) {
    openTranscriptInEditor(path);
  }
  return path;
}

/** Open latest.md in Cursor / VS Code when CARA_TRANSCRIPT_OPEN is not "0". */
export function openTranscriptInEditor(filePath: string): void {
  if (process.env.CARA_TRANSCRIPT_OPEN?.trim() === '0') return;
  if (!existsSync(filePath)) return;

  const trySpawn = (cmd: string, args: string[]): boolean => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {
        /* cursor/code CLI not on PATH — ignore */
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  };

  if (trySpawn('cursor', [filePath])) return;
  if (trySpawn('code', ['-r', filePath])) return;
  if (process.platform === 'darwin') {
    trySpawn('open', [filePath]);
  }
}
