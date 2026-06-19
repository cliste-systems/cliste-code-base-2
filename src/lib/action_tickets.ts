import { redactPii } from './gdpr.js';
import { getSupabaseClient } from './supabase.js';
import { postActionTicket, voiceWebhooksConfigured } from './voice_api.js';

export type EngineeringPriority = 'none' | 'urgent';

function directDbFallbackAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export async function insertActionTicket(input: {
  organizationId: string;
  calledNumber?: string;
  callerNumber: string;
  summary: string;
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
    console.error('[action_tickets] webhook failed', webhook.error);
    if (!directDbFallbackAllowed()) {
      console.error(
        '[action_tickets] CRITICAL: direct insert blocked in production — fix voice webhook',
      );
      throw new Error(webhook.error ?? 'action-ticket webhook failed');
    }
    console.warn('[action_tickets] falling back to direct insert (non-production only)');
  } else if (!directDbFallbackAllowed()) {
    console.error(
      '[action_tickets] CRITICAL: webhooks not configured in production',
    );
    throw new Error('voice webhooks not configured');
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
