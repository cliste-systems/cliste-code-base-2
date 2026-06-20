import { redactPii } from './gdpr.js';

const HTTP_FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.CLISTE_VOICE_HTTP_TIMEOUT_MS ?? '6000',
  10,
);

const CALL_COMPLETE_TIMEOUT_MS = Number.parseInt(
  process.env.CLISTE_VOICE_CALL_COMPLETE_TIMEOUT_MS ?? '15000',
  10,
);

/** Cap transcript size before POST to dashboard webhook. */
export const MAX_WEBHOOK_TRANSCRIPT_CHARS = 100_000;

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

export type SendSmsPayload = {
  called_number: string;
  to: string;
  body: string;
  caller_consented: boolean;
  skip_business_prefix?: boolean;
  purpose?: string;
};

function appBaseUrl(): string | null {
  const url = process.env.CLISTE_APP_URL?.trim() || '';
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

function capTranscriptField(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  const t = value.trim();
  if (!t) return null;
  if (t.length <= MAX_WEBHOOK_TRANSCRIPT_CHARS) return t;
  return `${t.slice(0, MAX_WEBHOOK_TRANSCRIPT_CHARS)}\n\n[Transcript truncated for webhook.]`;
}

function isFetchTimeoutError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  return err instanceof DOMException && err.name === 'AbortError';
}

function webhookFetchError(err: unknown): string {
  if (isFetchTimeoutError(err)) return 'timeout';
  return err instanceof Error ? err.message : String(err);
}

async function postVoiceWebhook<T>(
  path: string,
  payload: unknown,
  timeoutMsOverride?: number,
): Promise<{ res: Response; body: T }> {
  const base = appBaseUrl();
  if (!base || !voiceSecret()) {
    throw new Error('voice webhooks not configured');
  }

  const baseTimeout = timeoutMsOverride ?? HTTP_FETCH_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(baseTimeout)
    ? Math.min(Math.max(baseTimeout, 1000), 60_000)
    : 6000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = (await res.json().catch(() => ({}))) as T;
    return { res, body };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function postCallComplete(
  payload: CallCompletePayload,
): Promise<{ ok: boolean; callLogId?: string; error?: string }> {
  if (!voiceWebhooksConfigured()) {
    return { ok: false, error: 'voice webhooks not configured' };
  }

  try {
    const { res, body } = await postVoiceWebhook<{
      ok?: boolean;
      call_log_id?: string;
      error?: string;
    }>(
      '/api/voice/call-complete',
      {
        ...payload,
        transcript: capTranscriptField(payload.transcript ?? null),
        transcript_review: capTranscriptField(payload.transcript_review ?? null),
      },
      CALL_COMPLETE_TIMEOUT_MS,
    );

    if (!res.ok) {
      return {
        ok: false,
        error: body.error ?? `HTTP ${res.status}`,
      };
    }

    const callLogId = body.call_log_id?.trim();
    if (!callLogId) {
      return { ok: false, error: 'call-complete missing call_log_id' };
    }
    return { ok: true, callLogId };
  } catch (err) {
    return { ok: false, error: webhookFetchError(err) };
  }
}

export async function postActionTicket(
  payload: ActionTicketPayload,
): Promise<{ ok: boolean; error?: string }> {
  if (!voiceWebhooksConfigured()) {
    return { ok: false, error: 'voice webhooks not configured' };
  }

  try {
    const { res, body } = await postVoiceWebhook<{ ok?: boolean; error?: string }>(
      '/api/voice/action-ticket',
      {
        ...payload,
        summary: redactPii(payload.summary).trim(),
      },
    );

    if (!res.ok) {
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: webhookFetchError(err) };
  }
}

export async function postSendSms(
  payload: SendSmsPayload,
): Promise<{ ok: boolean; error?: string; to?: string; from?: string }> {
  if (!voiceWebhooksConfigured()) {
    return { ok: false, error: 'voice webhooks not configured' };
  }

  try {
    const { res, body } = await postVoiceWebhook<{
      ok?: boolean;
      error?: string;
      to?: string;
      from?: string;
    }>('/api/voice/send-sms', payload);

    if (!res.ok || body.ok !== true) {
      const error =
        res.status === 404 && !body.error
          ? 'SMS webhook route missing on CLISTE_APP_URL — deploy /api/voice/send-sms'
          : (body.error ?? `HTTP ${res.status}`);
      return { ok: false, error };
    }

    return {
      ok: true,
      ...(typeof body.to === 'string' && body.to ? { to: body.to } : {}),
      ...(typeof body.from === 'string' && body.from ? { from: body.from } : {}),
    };
  } catch (err) {
    return { ok: false, error: webhookFetchError(err) };
  }
}

export type SendCallerEmailPayload = {
  called_number: string;
  to: string;
  subject: string;
  body: string;
  caller_consented: boolean;
};

export async function postSendCallerEmail(
  payload: SendCallerEmailPayload,
): Promise<{ ok: boolean; error?: string }> {
  if (!voiceWebhooksConfigured()) {
    return { ok: false, error: 'voice webhooks not configured' };
  }

  try {
    const { res, body } = await postVoiceWebhook<{ ok?: boolean; error?: string }>(
      '/api/voice/send-caller-email',
      payload,
    );

    if (!res.ok || body.ok !== true) {
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: webhookFetchError(err) };
  }
}

export type SearchBusinessFilePayload = {
  called_number: string;
  query: string;
  file_id?: string;
  document_kind?: string;
};

export type SearchBusinessFileMatch = {
  file_id: string;
  file_name: string;
  document_kind: string | null;
  excerpts: Array<{
    text: string;
    score: number;
    start_line: number;
    end_line: number;
  }>;
};

export async function postSearchBusinessFile(
  payload: SearchBusinessFilePayload,
): Promise<{ ok: boolean; matches: SearchBusinessFileMatch[]; error?: string }> {
  if (!voiceWebhooksConfigured()) {
    return { ok: false, matches: [], error: 'voice webhooks not configured' };
  }

  try {
    const { res, body } = await postVoiceWebhook<{
      ok?: boolean;
      matches?: SearchBusinessFileMatch[];
      error?: string;
    }>('/api/voice/search-business-file', payload);

    if (!res.ok) {
      return {
        ok: false,
        matches: [],
        error: body.error ?? `HTTP ${res.status}`,
      };
    }

    return {
      ok: true,
      matches: Array.isArray(body.matches) ? body.matches : [],
    };
  } catch (err) {
    return { ok: false, matches: [], error: webhookFetchError(err) };
  }
}

/** Map session flags to canonical contract values. */
export function canonicalCallOutcome(flags: {
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
  return 'answered';
}
