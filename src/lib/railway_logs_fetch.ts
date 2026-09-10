import { spawnSync } from 'node:child_process';

export type FetchRailwayLogsInput = {
  startedAtMs: number;
  durationSeconds?: number;
  maxLines?: number;
  filter?: string;
};

export type FetchRailwayLogsResult = {
  logs: string | null;
  note: string;
};

function railwayCliAvailable(): boolean {
  const probe = spawnSync('railway', ['--version'], { encoding: 'utf8', timeout: 5000 });
  return probe.status === 0;
}

/**
 * Pull historical Railway logs for a call window (export scripts / local review).
 * Requires `railway` CLI linked to the voice worker project.
 */
export function fetchRailwayLogsForCall(input: FetchRailwayLogsInput): FetchRailwayLogsResult {
  if (process.env.CARA_SKIP_RAILWAY_LOGS?.trim() === '1') {
    return {
      logs: null,
      note: 'Railway log fetch skipped (CARA_SKIP_RAILWAY_LOGS=1).',
    };
  }

  if (!railwayCliAvailable()) {
    return {
      logs: null,
      note: 'Railway CLI not on PATH — install/link railway CLI to bundle logs automatically.',
    };
  }

  const padMs = Number.parseInt(process.env.CARA_RAILWAY_LOG_PAD_MS ?? '120000', 10);
  const durationMs = (input.durationSeconds ?? 120) * 1000;
  const since = new Date(input.startedAtMs - padMs).toISOString();
  const until = new Date(input.startedAtMs + durationMs + padMs).toISOString();
  const lines = input.maxLines ?? Number.parseInt(process.env.CARA_RAILWAY_LOG_LINES ?? '400', 10);
  const filter = input.filter ?? '[agent]';

  const args = [
    'logs',
    '--lines',
    String(lines),
    '--since',
    since,
    '--until',
    until,
    '--filter',
    filter,
  ];

  const service = process.env.RAILWAY_SERVICE?.trim();
  if (service) {
    args.push('--service', service);
  }

  const result = spawnSync('railway', args, {
    encoding: 'utf8',
    timeout: Number.parseInt(process.env.CARA_RAILWAY_LOG_TIMEOUT_MS ?? '45000', 10),
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    return {
      logs: null,
      note: `Railway logs fetch failed: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').trim();
    return {
      logs: null,
      note: `Railway logs exited ${result.status}: ${err || 'no output'}`,
    };
  }

  const text = (result.stdout || '').trim();
  if (!text) {
    return {
      logs: null,
      note: `Railway returned no lines for window ${since} → ${until} (filter: ${filter}).`,
    };
  }

  return {
    logs: text,
    note: `Fetched ${text.split('\n').length} lines (${since} → ${until}).`,
  };
}
