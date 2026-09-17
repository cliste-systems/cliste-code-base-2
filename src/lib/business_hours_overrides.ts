/** Load temporary opening-hours overrides for live Cara calls. */

import type { SupabaseClient } from '@supabase/supabase-js';

import { parseBankHolidayConfig } from './business_hours.js';

export type BusinessHoursOverrideRow = {
  id: string;
  organization_id: string;
  label: string;
  schedule: Record<string, unknown>;
  expires_at: string;
};

export async function loadActiveBusinessHoursOverride(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<BusinessHoursOverrideRow | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('business_hours_overrides')
    .select('id, organization_id, label, schedule, expires_at')
    .eq('organization_id', organizationId)
    .gt('expires_at', now)
    .order('expires_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    const message = error.message.toLowerCase();
    if (
      message.includes('schema cache') ||
      message.includes('does not exist') ||
      message.includes('could not find') ||
      message.includes('relation')
    ) {
      return null;
    }
    throw new Error(error.message);
  }

  if (!data?.id) return null;
  return {
    id: String(data.id),
    organization_id: String(data.organization_id),
    label: String(data.label ?? ''),
    schedule: (data.schedule as Record<string, unknown>) ?? {},
    expires_at: String(data.expires_at),
  };
}

/** Merge an active override into organizations.business_hours for programmatic hours replies. */
export function mergeHoursOverrideIntoBundle(
  businessHours: unknown,
  override: BusinessHoursOverrideRow | null,
): unknown {
  if (!override) return businessHours;

  const base =
    businessHours && typeof businessHours === 'object' && !Array.isArray(businessHours)
      ? { ...(businessHours as Record<string, unknown>) }
      : {};

  const merged: Record<string, unknown> = {
    ...base,
    ...override.schedule,
  };

  const label = override.label.trim();
  if (label) {
    merged._hoursNote = label;
  }

  const bank = parseBankHolidayConfig(businessHours);
  if (bank?.configured) {
    merged._bankHolidaysConfigured = true;
    merged._bankHolidaysOpen = bank.open;
  }

  return merged;
}
