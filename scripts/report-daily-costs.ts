/**
 * Prints last N days of estimated call costs from Supabase (call_logs.cost_estimate).
 * Run: npx tsx scripts/report-daily-costs.ts
 */
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const days = Number.parseInt(process.env.REPORT_COST_DAYS ?? '14', 10);

async function main() {
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const supabase = createClient(url, key);
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (Number.isFinite(days) ? days : 14));
  since.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('call_logs')
    .select('created_at, organization_id, duration_seconds, cost_estimate')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false });

  if (error) {
    console.error(error);
    process.exit(1);
  }

  type Row = {
    created_at: string;
    organization_id: string;
    duration_seconds: number | null;
    cost_estimate: { totalUsd?: number; breakdown?: Record<string, number> } | null;
  };

  const rows = (data ?? []) as Row[];

  const byDayOrg = new Map<string, { total: number; breakdown: Record<string, number>; calls: number }>();

  for (const r of rows) {
    const day = (r.created_at ?? '').slice(0, 10);
    if (!day) {
      continue;
    }
    const k = `${day}|${r.organization_id}`;
    const cur = byDayOrg.get(k) ?? {
      total: 0,
      breakdown: {
        livekit: 0,
        stt: 0,
        llmVoice: 0,
        tts: 0,
        twilioVoice: 0,
        twilioSms: 0,
        supabase: 0,
        postprocessLlm: 0,
      },
      calls: 0,
    };
    cur.calls += 1;
    const ce = r.cost_estimate;
    if (ce && typeof ce.totalUsd === 'number') {
      cur.total += ce.totalUsd;
      const b = ce.breakdown;
      if (b && typeof b === 'object') {
        const br = b as Record<string, unknown>;
        for (const bk of Object.keys(cur.breakdown) as (keyof typeof cur.breakdown)[]) {
          const v = br[bk];
          if (typeof v === 'number') {
            cur.breakdown[bk] = (cur.breakdown[bk] ?? 0) + v;
          }
        }
      }
    }
    byDayOrg.set(k, cur);
  }

  const sorted = [...byDayOrg.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log('Day (UTC) | organization_id | calls | est_total_usd | livekit stt llm tts twilio_v twilio_sms postprocess');
  for (const [key, agg] of sorted) {
    const parts = key.split('|');
    const day = parts[0] ?? '';
    const org = parts[1] ?? '';
    const b = agg.breakdown;
    console.log(
      `${day} | ${org} | ${agg.calls} | ${agg.total.toFixed(5)} | ` +
        `${(b.livekit ?? 0).toFixed(4)} ${(b.stt ?? 0).toFixed(4)} ${(b.llmVoice ?? 0).toFixed(4)} ${(b.tts ?? 0).toFixed(4)} ` +
        `${(b.twilioVoice ?? 0).toFixed(4)} ${(b.twilioSms ?? 0).toFixed(4)} ${(b.postprocessLlm ?? 0).toFixed(4)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
