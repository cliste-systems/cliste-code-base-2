import { redactPii } from './gdpr.js';

export type CallCompletePayload = {
  called_number: string;
  call_sid: string | null;
  room_name?: string | null;
  caller_number: string;
  caller_name?: string | null;
  duration_seconds: number;
  outcome: string;
  transcript?: string | null;
  transcript_review?: string | null;
  ai_summary?: string | null;
  disclosure_confirmed?: boolean;
  knowledge_gaps?: Array<{
    topic: string;
    caller_context?: string;
    cara_question?: string;
    suggested_section?: string;
  }>;
};

export type ActionTicketPayload = {
  called_number: string;
  caller_number: string;
  caller_name?: string | null;
  summary: string;
};

function appBaseUrl(): string | null {
  const url =
    process.env.CLISTE_APP_URL?.trim() ||
    process.env.CLISTE_BOOKING_SITE_URL?.trim() ||
    '';
  if (!url) return null;
  return url.replace(/\/$/, '');
}

function voiceSecret(): string | null {
  return process.env.CLISTE_VOICE_WEBHOOK_SECRET?.trim() || null;
}

function authHeaders(): Record<string, string> {
  const secret = voiceSecret();
  if (!secret) {
    throw new Error('CLISTE_VOICE_WEBHOOK_SECRET is not set');
  }
  return {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  };
}

export function voiceWebhooksConfigured(): boolean {
  return Boolean(appBaseUrl() && voiceSecret());
}

export async function postCallComplete(
  payload: CallCompletePayload,
): Promise<{ ok: boolean; callLogId?: string; error?: string }> {
  const base = appBaseUrl();
  if (!base || !voiceSecret()) {
    return { ok: false, error: 'voice webhooks not configured' };
  }

  const res = await fetch(`${base}/api/voice/call-complete`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    call_log_id?: string;
    error?: string;
  };

  if (!res.ok) {
    return {
      ok: false,
      error: body.error ?? `HTTP ${res.status}`,
    };
  }

  const callLogId = body.call_log_id?.trim();
  return callLogId ? { ok: true, callLogId } : { ok: true };
}

export async function postActionTicket(
  payload: ActionTicketPayload,
): Promise<{ ok: boolean; error?: string }> {
  const base = appBaseUrl();
  if (!base || !voiceSecret()) {
    return { ok: false, error: 'voice webhooks not configured' };
  }

  const res = await fetch(`${base}/api/voice/action-ticket`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      ...payload,
      summary: redactPii(payload.summary).trim(),
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };

  if (!res.ok) {
    return { ok: false, error: body.error ?? `HTTP ${res.status}` };
  }

  return { ok: true };
}

/** Map legacy worker outcomes to canonical contract values. */
export function canonicalCallOutcome(flags: {
  appointmentBooked?: boolean;
  linkSent?: boolean;
  actionTicketCreated?: boolean;
  callbackRequested?: boolean;
  endPhoneCallUsed?: boolean;
  failed?: boolean;
  voicemail?: boolean;
  spam?: boolean;
}): string {
  if (flags.spam) return 'spam_or_abuse';
  if (flags.voicemail) return 'voicemail_or_no_speech';
  if (flags.failed) return 'failed';
  if (flags.linkSent) return 'link_sent';
  if (flags.callbackRequested) return 'callback_requested';
  if (flags.actionTicketCreated) return 'action_created';
  if (flags.appointmentBooked) return 'answered';
  return 'answered';
}
