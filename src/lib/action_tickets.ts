import { redactPii } from './gdpr.js';
import { getSupabaseClient } from './supabase.js';
import { postActionTicket, voiceWebhooksConfigured } from './voice_api.js';

export type EngineeringPriority = 'none' | 'urgent';

export async function insertActionTicket(input: {
  organizationId: string;
  calledNumber?: string;
  callerNumber: string;
  summary: string;
  /** Voice agent uses `urgent` for every ticket so platform admin is notified; `none` for other callers if needed. */
  engineeringPriority?: EngineeringPriority;
}): Promise<void> {
  const summary = redactPii(input.summary).trim();
  const calledNumber = input.calledNumber?.trim() ?? '';
  if (voiceWebhooksConfigured() && calledNumber) {
    const webhook = await postActionTicket({
      called_number: calledNumber,
      caller_number: input.callerNumber.trim() || 'unknown',
      summary,
    });
    if (webhook.ok) {
      return;
    }
    console.error('[action_tickets] webhook failed, falling back to direct insert', webhook.error);
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase.from('action_tickets').insert({
    organization_id: input.organizationId,
    caller_number: input.callerNumber.trim() || 'unknown',
    summary,
    status: 'open',
    engineering_priority: input.engineeringPriority ?? 'none',
  });
  if (error) {
    throw error;
  }
}
