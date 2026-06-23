import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  mirrorCallTranscriptToWorkspace,
  type CallTranscriptMirrorInput,
  type CallTranscriptMirrorOptions,
} from './call_transcript_mirror.js';
import {
  assessTranscriptCompleteness,
  type TranscriptCompleteness,
} from './transcript_completeness.js';

export type LatestCallRow = {
  id: string;
  created_at: string;
  duration_seconds: number | null;
  outcome: string | null;
  transcript: string | null;
  ai_summary: string | null;
  caller_number: string | null;
};

export type SyncLatestCallOptions = {
  /** Poll until a matching row is complete (or timeout). */
  wait?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  /** Only accept call_logs.created_at at or after this instant. */
  minCreatedAtMs?: number;
  /** Refuse to write when transcript is incomplete (default true). */
  requireComplete?: boolean;
  /** On wait timeout, write partial with banner instead of failing (default false). */
  allowPartialOnTimeout?: boolean;
  /** Open latest.md in editor after write (default true). */
  openInEditor?: boolean;
};

export type SyncLatestCallResult = {
  path: string | null;
  status: 'written' | 'incomplete' | 'timeout' | 'no_rows' | 'missing_config';
  row: LatestCallRow | null;
  completeness: TranscriptCompleteness | null;
};

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_POLL_MS = 3_000;
const WAIT_NEW_SKEW_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveSyncLatestCallOptions(
  overrides?: SyncLatestCallOptions,
): Required<SyncLatestCallOptions> {
  return {
    wait: overrides?.wait ?? false,
    timeoutMs: overrides?.timeoutMs ?? parsePositiveInt(process.env.CARA_TRANSCRIPT_WAIT_MS, DEFAULT_WAIT_MS),
    pollMs: overrides?.pollMs ?? parsePositiveInt(process.env.CARA_TRANSCRIPT_POLL_MS, DEFAULT_POLL_MS),
    minCreatedAtMs: overrides?.minCreatedAtMs ?? Number.NaN,
    requireComplete: overrides?.requireComplete ?? true,
    allowPartialOnTimeout: overrides?.allowPartialOnTimeout ?? false,
    openInEditor: overrides?.openInEditor ?? true,
  };
}

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

export type FetchLatestCallOptions = {
  minCreatedAtMs?: number;
};

export async function fetchLatestCallRow(
  sb: SupabaseClient,
  options?: FetchLatestCallOptions,
): Promise<LatestCallRow | null> {
  let query = sb
    .from('call_logs')
    .select('id,created_at,duration_seconds,outcome,transcript,ai_summary,caller_number')
    .order('created_at', { ascending: false })
    .limit(1);

  if (options?.minCreatedAtMs != null && Number.isFinite(options.minCreatedAtMs)) {
    query = query.gte('created_at', new Date(options.minCreatedAtMs).toISOString());
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

export async function fetchCallRowById(
  sb: SupabaseClient,
  callLogId: string,
): Promise<LatestCallRow | null> {
  const { data, error } = await sb
    .from('call_logs')
    .select('id,created_at,duration_seconds,outcome,transcript,ai_summary,caller_number')
    .eq('id', callLogId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function mirrorLatestCall(
  input: CallTranscriptMirrorInput,
  options?: CallTranscriptMirrorOptions & { openInEditor?: boolean },
): string | null {
  const path = mirrorCallTranscriptToWorkspace(input, options);
  if (path && options?.openInEditor !== false) {
    openTranscriptInEditor(path);
  }
  return path;
}

function mirrorRow(
  row: LatestCallRow,
  completeness: TranscriptCompleteness,
  openInEditor: boolean,
): string | null {
  return mirrorLatestCall(rowToMirrorInput(row), {
    partial: !completeness.complete,
    partialReasons: completeness.reasons,
    openInEditor,
  });
}

/** Pull latest Supabase call_logs row into call-transcripts/latest.md */
export async function syncLatestCallFromSupabase(
  sb?: SupabaseClient,
  overrides?: SyncLatestCallOptions,
): Promise<SyncLatestCallResult> {
  const opts = resolveSyncLatestCallOptions(overrides);
  const client = sb ?? getSupabaseForTranscriptSync();
  if (!client) {
    console.error('[transcript_sync] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    return { path: null, status: 'missing_config', row: null, completeness: null };
  }

  const fetchOpts =
    Number.isFinite(opts.minCreatedAtMs)
      ? { minCreatedAtMs: opts.minCreatedAtMs }
      : undefined;

  const deadline = opts.wait ? Date.now() + opts.timeoutMs : Date.now();
  let lastRow: LatestCallRow | null = null;
  let lastCompleteness: TranscriptCompleteness | null = null;

  while (true) {
    const row = await fetchLatestCallRow(client, fetchOpts);
    if (row) {
      lastRow = row;
      lastCompleteness = assessTranscriptCompleteness(row.transcript);

      if (!opts.requireComplete || lastCompleteness.complete) {
        const path = mirrorRow(row, lastCompleteness, opts.openInEditor);
        return {
          path,
          status: 'written',
          row,
          completeness: lastCompleteness,
        };
      }

      if (!opts.wait) {
        console.error('[transcript_sync] latest call incomplete', {
          callLogId: row.id,
          reasons: lastCompleteness.reasons,
        });
        return {
          path: null,
          status: 'incomplete',
          row,
          completeness: lastCompleteness,
        };
      }
    } else if (!opts.wait) {
      console.error('[transcript_sync] no call_logs rows');
      return { path: null, status: 'no_rows', row: null, completeness: null };
    }

    if (!opts.wait || Date.now() >= deadline) break;
    await sleep(opts.pollMs);
  }

  if (lastRow && opts.allowPartialOnTimeout && lastCompleteness) {
    const path = mirrorRow(lastRow, lastCompleteness, opts.openInEditor);
    console.warn('[transcript_sync] timed out — wrote partial transcript', {
      callLogId: lastRow.id,
      reasons: lastCompleteness.reasons,
    });
    return {
      path,
      status: 'written',
      row: lastRow,
      completeness: lastCompleteness,
    };
  }

  console.error('[transcript_sync] timed out waiting for complete transcript', {
    callLogId: lastRow?.id ?? null,
    reasons: lastCompleteness?.reasons ?? ['no matching call_logs row'],
    waitMs: opts.timeoutMs,
  });
  return {
    path: null,
    status: lastRow ? 'timeout' : 'no_rows',
    row: lastRow,
    completeness: lastCompleteness,
  };
}

/** Options for `npm run export:latest-call -- --wait` after a phone test. */
export function exportWaitOptionsFromArgv(argv: string[] = process.argv.slice(2)): SyncLatestCallOptions {
  const waitNew =
    argv.includes('--wait-new') ||
    (argv.includes('--wait') && !argv.includes('--latest'));
  const wait =
    waitNew ||
    argv.includes('--wait') ||
    process.env.CARA_TRANSCRIPT_WAIT?.trim() === '1';
  const noWait = argv.includes('--no-wait');

  const startedAtMs = Date.now() - WAIT_NEW_SKEW_MS;

  return {
    wait: wait && !noWait,
    minCreatedAtMs: waitNew ? startedAtMs : Number.NaN,
    allowPartialOnTimeout: argv.includes('--allow-partial'),
    requireComplete: !argv.includes('--allow-partial'),
  };
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
