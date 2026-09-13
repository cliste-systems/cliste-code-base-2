import { randomUUID } from 'node:crypto';

import { voiceWebhooksConfigured } from './voice_api.js';

export type PipelineIncidentStage = 'stt' | 'llm' | 'tts' | 'session' | 'unknown';

export type PipelineIncidentInput = {
  organizationId?: string | null;
  calledNumber?: string | null;
  callerNumber?: string | null;
  roomName?: string | null;
  callSid?: string | null;
  stage: PipelineIncidentStage;
  errorMessage: string;
  modelLabel?: string | null;
  retryable?: boolean;
};

function appBaseUrl(): string | null {
  const url = process.env.CLISTE_APP_URL?.trim() || '';
  if (!url) return null;
  return url.replace(/\/$/, '');
}

function voiceSecret(): string | null {
  return process.env.CLISTE_VOICE_WEBHOOK_SECRET?.trim() || null;
}

export async function postPipelineIncident(
  input: PipelineIncidentInput,
): Promise<{ ok: boolean; error?: string }> {
  if (!voiceWebhooksConfigured()) {
    return { ok: false, error: 'voice webhooks not configured' };
  }
  const base = appBaseUrl();
  const secret = voiceSecret();
  if (!base || !secret) {
    return { ok: false, error: 'voice webhooks not configured' };
  }

  const message = input.errorMessage.trim().slice(0, 500);
  if (!message) return { ok: false, error: 'empty error message' };

  try {
    const res = await fetch(`${base}/api/voice/pipeline-incident`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        incident_id: randomUUID(),
        organization_id: input.organizationId ?? null,
        called_number: input.calledNumber ?? null,
        caller_number: input.callerNumber ?? null,
        room_name: input.roomName ?? null,
        call_sid: input.callSid ?? null,
        stage: input.stage,
        error_message: message,
        model_label: input.modelLabel ?? null,
        retryable: input.retryable ?? null,
        occurred_at: new Date().toISOString(),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function classifyPipelineErrorStage(message: string): PipelineIncidentStage {
  const m = message.toLowerCase();
  if (m.includes('synthesize') || m.includes('cartesia') || m.includes('tts')) return 'tts';
  if (m.includes('llm') || m.includes('openai') || m.includes('completion') || m.includes('credit')) {
    return 'llm';
  }
  if (m.includes('stt') || m.includes('transcri')) return 'stt';
  return 'unknown';
}
