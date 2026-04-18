import { getSupabaseClient } from './supabase.js';

/**
 * Per-call metering for Stripe Billing overage.
 *
 * Each AI call writes one row into `public.usage_records`:
 *   1. `startUsageRecord` at session start — so even calls that crash mid-way
 *      are visible in the dashboard (with `ended_at=null`).
 *   2. `finishUsageRecord` on session close — fills in `ended_at` and
 *      `minutes_billable`, which the nightly cron in cliste-code-base-1 rolls
 *      up into Stripe metered usage records.
 *
 * Both are best-effort: failures are logged but never surface to the caller,
 * because losing a metering row must not take an in-flight call off the line.
 */

export type StartUsageInput = {
  organizationId: string;
  planTier: string | null | undefined;
  planQuotaMinutes: number | null | undefined;
  callSid: string | null | undefined;
  roomName: string | null | undefined;
  callerNumber: string | null | undefined;
  billingPeriodStart: string;
};

export async function startUsageRecord(input: StartUsageInput): Promise<string | null> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('usage_records')
      .insert({
        organization_id: input.organizationId,
        call_sid: input.callSid ?? null,
        room_name: input.roomName ?? null,
        caller_number: input.callerNumber ?? null,
        started_at: new Date().toISOString(),
        billing_period_start: input.billingPeriodStart,
        plan_tier_at_time: input.planTier ?? null,
        plan_quota_at_time:
          typeof input.planQuotaMinutes === 'number' ? input.planQuotaMinutes : null,
      })
      .select('id')
      .single();
    if (error) {
      console.warn('[usage] startUsageRecord failed', error.message);
      return null;
    }
    return typeof data?.id === 'string' ? data.id : null;
  } catch (err) {
    console.warn(
      '[usage] startUsageRecord threw',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function finishUsageRecord(input: {
  usageId: string;
  durationSeconds: number;
}): Promise<void> {
  if (!input.usageId) {
    return;
  }
  // Stripe metered billing is typically priced per minute; round UP to the
  // next whole minute so a 61-second call bills as 2 minutes (matching
  // Twilio + LiveKit conventions).
  const minutes = Math.max(
    0,
    Math.ceil(Math.max(0, input.durationSeconds) / 60),
  );
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('usage_records')
      .update({
        ended_at: new Date().toISOString(),
        minutes_billable: minutes,
      })
      .eq('id', input.usageId);
    if (error) {
      console.warn('[usage] finishUsageRecord failed', error.message);
    }
  } catch (err) {
    console.warn(
      '[usage] finishUsageRecord threw',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Compute the current billing period anchor (YYYY-MM-DD). Prefer the value
 * on the organisation row (mirrors the Stripe subscription's current period
 * start) and only fall back to the first day of the current UTC month when
 * the column isn't populated yet.
 */
export function currentBillingPeriodStart(
  orgBillingPeriodStart?: string | null,
  now: Date = new Date(),
): string {
  if (
    typeof orgBillingPeriodStart === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(orgBillingPeriodStart)
  ) {
    return orgBillingPeriodStart;
  }
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * Sum the salon's billable minutes inside the current billing period. Used
 * by the agent to decide whether to refuse a new call when the salon is
 * already over their plan quota — the metering row alone tracks billing
 * but does NOT cap costs without this gate.
 *
 * Counts BOTH closed records (minutes_billable) AND open ones (rounded up
 * from `started_at` → now) so a long in-flight call still counts toward
 * the cap. Returns null on DB error so callers can fail-open if metering
 * is broken (better to let the call through than to drop legitimate
 * traffic if Supabase is having a moment).
 *
 * Open-row estimates are bounded so a single zombie row (worker crash,
 * SIGKILL, deploy mid-call) cannot lock the whole salon out of inbound
 * calls. Anything we'd estimate above MAX_OPEN_MINUTES is treated as a
 * zombie and ignored — the real billable minutes are captured by the
 * call_logs / Twilio reconciliation cron.
 */
const MAX_OPEN_MINUTES_PER_ROW = 30;
const ZOMBIE_OPEN_AGE_MS = 6 * 60 * 60 * 1000;

export async function sumUsageMinutesThisPeriod(input: {
  organizationId: string;
  billingPeriodStart: string;
}): Promise<number | null> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('usage_records')
      .select('minutes_billable, started_at, ended_at')
      .eq('organization_id', input.organizationId)
      .eq('billing_period_start', input.billingPeriodStart);
    if (error) {
      console.warn('[usage] sumUsageMinutesThisPeriod failed', error.message);
      return null;
    }
    let total = 0;
    const now = Date.now();
    for (const row of data ?? []) {
      const billed =
        typeof (row as { minutes_billable?: number }).minutes_billable === 'number'
          ? (row as { minutes_billable: number }).minutes_billable
          : null;
      if (billed != null) {
        total += billed;
        continue;
      }
      const startedAt = (row as { started_at?: string | null }).started_at;
      if (!startedAt) continue;
      const startedMs = Date.parse(startedAt);
      if (!Number.isFinite(startedMs)) continue;
      const ageMs = now - startedMs;
      if (ageMs > ZOMBIE_OPEN_AGE_MS) {
        // Almost certainly a worker crash that never wrote ended_at. Don't
        // let it count against quota; nightly cleanup will close it.
        console.warn('[usage] ignoring zombie open usage row', {
          startedAt,
          ageMinutes: Math.round(ageMs / 60_000),
        });
        continue;
      }
      const estimated = Math.max(0, Math.ceil(ageMs / 60_000));
      total += Math.min(estimated, MAX_OPEN_MINUTES_PER_ROW);
    }
    return total;
  } catch (err) {
    console.warn(
      '[usage] sumUsageMinutesThisPeriod threw',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Best-effort sweep of open usage rows older than ZOMBIE_OPEN_AGE_MS.
 * Closes them out at started_at with minutes_billable=0 so they survive
 * for audit but don't poison the quota gate (which previously summed
 * `now - started_at` for any open row, locking out salons after a worker
 * crash). Safe to call from agent boot — runs once, fail-silent.
 */
export async function reapZombieUsageRows(): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const cutoffIso = new Date(Date.now() - ZOMBIE_OPEN_AGE_MS).toISOString();
    const { data, error } = await supabase
      .from('usage_records')
      .select('id, started_at')
      .is('ended_at', null)
      .lt('started_at', cutoffIso)
      .limit(500);
    if (error) {
      console.warn('[usage] reapZombieUsageRows select failed', error.message);
      return;
    }
    const rows = (data ?? []) as Array<{ id: string; started_at: string }>;
    if (rows.length === 0) return;
    for (const row of rows) {
      const { error: updErr } = await supabase
        .from('usage_records')
        .update({ ended_at: row.started_at, minutes_billable: 0 })
        .eq('id', row.id)
        .is('ended_at', null);
      if (updErr) {
        console.warn('[usage] reapZombieUsageRows update failed', {
          id: row.id,
          message: updErr.message,
        });
      }
    }
    console.warn('[usage] reaped zombie usage rows', { count: rows.length });
  } catch (err) {
    console.warn(
      '[usage] reapZombieUsageRows threw',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Minutes included per plan tier. Kept in sync with cliste-code-base-1's
 * `src/lib/cliste-plans.ts`. Returns null for unknown/enterprise tiers so
 * the metering row doesn't claim a false quota.
 */
export function planQuotaMinutes(tier: string | null | undefined): number | null {
  switch ((tier ?? '').toLowerCase()) {
    case 'starter':
      return 150;
    case 'pro':
      return 500;
    case 'business':
      return 1500;
    case 'enterprise':
      return 4000;
    default:
      return null;
  }
}
