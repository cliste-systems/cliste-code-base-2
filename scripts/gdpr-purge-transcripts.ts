/**
 * GDPR Art 5(1)(e) — storage limitation.
 *
 * Nulls the verbatim `transcript` and `transcript_review` columns on
 * `call_logs` rows older than `--days` (default 30). Keeps:
 *   - the `ai_summary` (short, owner-facing — useful for diary recall)
 *   - the `outcome` + `cost_estimate` + `caller_number` (for invoicing /
 *     billing reconciliation under Art 6(1)(f) legitimate interest).
 *
 * Run as a daily/weekly cron in Railway:
 *   npx tsx scripts/gdpr-purge-transcripts.ts --days=30
 *   npx tsx scripts/gdpr-purge-transcripts.ts --days=30 --dry-run
 */
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';

function parseFlag(name: string, fallback: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) {
    return fallback;
  }
  return arg.slice(name.length + 3);
}

async function main() {
  const days = Number.parseInt(
    parseFlag('days', process.env.CLISTE_TRANSCRIPT_RETENTION_DAYS ?? '30'),
    10,
  );
  const dryRun = process.argv.includes('--dry-run');
  if (!Number.isFinite(days) || days < 1) {
    console.error('--days must be a positive integer');
    process.exit(2);
  }

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);

  console.log(`Purging transcripts on call_logs older than ${cutoff.toISOString()} (${days} days). dry-run=${dryRun}`);

  const { data: matches, error: lookupErr } = await supabase
    .from('call_logs')
    .select('id, created_at')
    .lt('created_at', cutoff.toISOString())
    .not('transcript', 'is', null);
  if (lookupErr) {
    console.error('lookup failed', lookupErr);
    process.exit(1);
  }
  const count = matches?.length ?? 0;
  console.log(`Rows with non-null transcripts older than cutoff: ${count}`);

  if (count === 0 || dryRun) {
    return;
  }

  const { error } = await supabase
    .from('call_logs')
    .update({ transcript: null, transcript_review: null })
    .lt('created_at', cutoff.toISOString())
    .not('transcript', 'is', null);
  if (error) {
    console.error('purge failed', error);
    process.exit(1);
  }
  console.log(`Purged ${count} transcript(s).`);
}

void main();
