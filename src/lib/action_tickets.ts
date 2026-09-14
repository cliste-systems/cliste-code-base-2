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
  departmentSlug?: string;
  routeId?: string;
}): Promise<void> {
  const summary = redactPii(input.summary).trim();
  const calledNumber = input.calledNumber?.trim() ?? '';
  const callerName = input.callerName?.trim() || undefined;
  const routeId = input.routeId?.trim() || undefined;
  const departmentSlug = input.departmentSlug?.trim() || undefined;

  if (voiceWebhooksConfigured() && calledNumber) {
    const webhook = await postActionTicket({
      called_number: calledNumber,
      caller_number: input.callerNumber.trim() || 'unknown',
      caller_name: callerName ?? null,
      summary,
      department_slug: departmentSlug ?? null,
      route_id: routeId ?? null,
    });
    if (webhook.ok) {
      return;
    }
    console.error('[action_tickets] webhook failed', webhook.error);
    throw new Error(
      webhook.error ??
        'action-ticket webhook failed — check CLISTE_APP_URL and CLISTE_VOICE_WEBHOOK_SECRET on the voice worker',
    );
  }

  if (!directDbFallbackAllowed()) {
    console.error(
      '[action_tickets] CRITICAL: webhooks not configured and no service role for fallback',
    );
    throw new Error('voice webhooks not configured');
  }

  console.warn(
    '[action_tickets] webhook not configured — direct insert without department routing (dev only)',
  );
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('action_tickets').insert({
    organization_id: input.organizationId,
    caller_number: input.callerNumber.trim() || 'unknown',
    caller_name: callerName ?? null,
    summary,
    status: 'open',
    engineering_priority: input.engineeringPriority ?? 'none',
  });
  if (error) {
    throw error;
  }
}
