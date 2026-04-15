import { getSupabaseClient } from './supabase.js';

export type EngineeringPriority = 'none' | 'urgent';

export async function insertActionTicket(input: {
  organizationId: string;
  callerNumber: string;
  summary: string;
  /** Voice agent uses `urgent` for every ticket so platform admin is notified; `none` for other callers if needed. */
  engineeringPriority?: EngineeringPriority;
}): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('action_tickets').insert({
    organization_id: input.organizationId,
    caller_number: input.callerNumber.trim() || 'unknown',
    summary: input.summary.trim(),
    status: 'open',
    engineering_priority: input.engineeringPriority ?? 'none',
  });
  if (error) {
    throw error;
  }
}
