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
 */
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
      // Open record — estimate from started_at so a long ongoing call counts.
      const startedAt = (row as { started_at?: string | null }).started_at;
      if (startedAt) {
        const startedMs = Date.parse(startedAt);
        if (Number.isFinite(startedMs)) {
          total += Math.max(0, Math.ceil((now - startedMs) / 60_000));
        }
      }
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
