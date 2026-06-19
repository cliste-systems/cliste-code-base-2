import { redactPii } from './gdpr.js';
import { getSupabaseClient } from './supabase.js';
import { postActionTicket, voiceWebhooksConfigured } from './voice_api.js';

export type EngineeringPriority = 'none' | 'urgent';

function directDbFallbackAllowed(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

export async function insertActionTicket(input: {
  organizationId: string;
  calledNumber?: string;
  callerNumber: string;
  callerName?: string;
  summary: string;
  engineeringPriority?: EngineeringPriority;
}): Promise<void> {
  const summary = redactPii(input.summary).trim();
  const calledNumber = input.calledNumber?.trim() ?? '';
  const callerName = input.callerName?.trim() || undefined;
  if (voiceWebhooksConfigured() && calledNumber) {
    const webhook = await postActionTicket({
      called_number: calledNumber,
      caller_number: input.callerNumber.trim() || 'unknown',
      caller_name: callerName ?? null,
      summary,
    });
    if (webhook.ok) {
      return;
    }
    console.error('[action_tickets] webhook failed', webhook.error);
    if (!directDbFallbackAllowed()) {
      console.error(
        '[action_tickets] CRITICAL: direct insert blocked — fix voice webhook or set SUPABASE_SERVICE_ROLE_KEY',
      );
      throw new Error(webhook.error ?? 'action-ticket webhook failed');
    }
    console.warn('[action_tickets] falling back to direct insert');
  } else if (!directDbFallbackAllowed()) {
    console.error(
      '[action_tickets] CRITICAL: webhooks not configured and no service role for fallback',
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
