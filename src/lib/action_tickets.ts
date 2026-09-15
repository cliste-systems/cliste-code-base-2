import { redactPii } from './gdpr.js';
import { getSupabaseClient } from './supabase.js';
import type { ActionTicketDeliveryStatus } from './post_call_processing.js';
import { postActionTicket, voiceWebhooksConfigured } from './voice_api.js';

export type EngineeringPriority = 'none' | 'urgent';

function directDbFallbackAllowed(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

async function insertActionTicketDirect(input: {
  organizationId: string;
  callerNumber: string;
  callerName?: string;
  summary: string;
  engineeringPriority?: EngineeringPriority;
  departmentSlug?: string;
  callLogId?: string | null;
  deliveryStatus?: ActionTicketDeliveryStatus;
}): Promise<void> {
  if (!directDbFallbackAllowed()) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured for direct ticket insert');
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase.from('action_tickets').insert({
    organization_id: input.organizationId,
    caller_number: input.callerNumber.trim() || 'unknown',
    caller_name: input.callerName?.trim() || null,
    summary: input.summary,
    status: 'open',
    engineering_priority: input.engineeringPriority ?? 'none',
    ...(input.departmentSlug ? { department_slug: input.departmentSlug } : {}),
    ...(input.callLogId ? { call_log_id: input.callLogId } : {}),
    delivery_status: input.deliveryStatus ?? 'confirmed',
  });
  if (error) {
    throw error;
  }
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
  callLogId?: string | null;
  deliveryStatus?: ActionTicketDeliveryStatus;
}): Promise<void> {
  const summary = redactPii(input.summary).trim();
  const calledNumber = input.calledNumber?.trim() ?? '';
  const callerName = input.callerName?.trim() || undefined;
  const routeId = input.routeId?.trim() || undefined;
  const departmentSlug = input.departmentSlug?.trim() || undefined;
  const callLogId = input.callLogId?.trim() || null;
  const deliveryStatus = input.deliveryStatus ?? 'confirmed';

  if (voiceWebhooksConfigured() && calledNumber) {
    const webhook = await postActionTicket({
      called_number: calledNumber,
      caller_number: input.callerNumber.trim() || 'unknown',
      caller_name: callerName ?? null,
      summary,
      department_slug: departmentSlug ?? null,
      route_id: routeId ?? null,
      call_log_id: callLogId,
      delivery_status: deliveryStatus,
    });
    if (webhook.ok) {
      return;
    }
    console.error('[action_tickets] webhook failed — trying direct DB fallback', webhook.error);
    if (directDbFallbackAllowed()) {
      await insertActionTicketDirect({
        organizationId: input.organizationId,
        callerNumber: input.callerNumber,
        summary,
        ...(callerName ? { callerName } : {}),
        ...(input.engineeringPriority ? { engineeringPriority: input.engineeringPriority } : {}),
        ...(departmentSlug ? { departmentSlug } : {}),
        ...(callLogId ? { callLogId } : {}),
        deliveryStatus,
      });
      return;
    }
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
  await insertActionTicketDirect({
    organizationId: input.organizationId,
    callerNumber: input.callerNumber,
    summary,
    ...(callerName ? { callerName } : {}),
    ...(input.engineeringPriority ? { engineeringPriority: input.engineeringPriority } : {}),
    ...(departmentSlug ? { departmentSlug } : {}),
    ...(callLogId ? { callLogId } : {}),
    deliveryStatus,
  });
}
