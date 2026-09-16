import { voiceWebhooksConfigured } from './voice_api.js';

export type PlatformEventSeverity = 'critical' | 'warning' | 'info';

export type PlatformEventCategory =
  | 'recording'
  | 'webhook'
  | 'product_lookup'
  | 'worker'
  | 'dashboard';

export type PlatformEventInput = {
  severity: PlatformEventSeverity;
  category: PlatformEventCategory;
  eventType: string;
  message: string;
  organizationId?: string | null;
  callLogId?: string | null;
  calledNumber?: string | null;
  metadata?: Record<string, unknown>;
};

function appBaseUrl(): string | null {
  const url = process.env.CLISTE_APP_URL?.trim() || '';
  if (!url) return null;
  return url.replace(/\/$/, '');
}

function voiceSecret(): string | null {
  return process.env.CLISTE_VOICE_WEBHOOK_SECRET?.trim() || null;
}

/** Fire-and-forget — never block the call path on telemetry. */
export function reportPlatformEvent(input: PlatformEventInput): void {
  if (!voiceWebhooksConfigured()) return;
  const base = appBaseUrl();
  const secret = voiceSecret();
  if (!base || !secret) return;

  const message = input.message.trim().slice(0, 500);
  if (!message) return;

  void fetch(`${base}/api/voice/platform-event`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      severity: input.severity,
      category: input.category,
      event_type: input.eventType,
      message,
      organization_id: input.organizationId ?? null,
      call_log_id: input.callLogId ?? null,
      called_number: input.calledNumber ?? null,
      metadata: input.metadata ?? {},
    }),
  }).catch((err) => {
    console.warn('[platform-event] post failed', err);
  });
}
