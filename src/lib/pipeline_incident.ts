// Pipeline-incident soft-landing.
//
// Fires when the agent's STT/LLM/TTS pipeline dies mid-call with an
// `unrecoverable` error — the worst UX on the system: caller hears dead
// air and the line drops a few seconds later. We:
//
//   1. Log a structured line for ops grep.
//   2. POST a redacted incident to the admin dashboard (see
//      cliste-code-base-1 /api/voice/pipeline-incident) so it shows up
//      on /admin under "Voice pipeline health".
//   3. Fire an SMS booking-link fallback to the caller (when we have the
//      Twilio creds and a salon booking URL) so the call still converts
//      even though the line is about to drop.
//   4. Force-disconnect the SIP leg so the caller doesn't sit on 30+
//      seconds of silence waiting for the AgentSession to close itself.
//
// Everything here is best-effort and swallows its own errors — this is
// the last-ditch cleanup code, it MUST NOT throw and take the process
// down with the caller.
import { randomUUID } from 'node:crypto';
import { RoomServiceClient } from 'livekit-server-sdk';
import twilio from 'twilio';

import { maskPhone } from './gdpr.js';

export type PipelineIncidentStage = 'stt' | 'llm' | 'tts' | 'session' | 'unknown';

export type PipelineIncidentInput = {
  organizationId: string | null;
  /** E.164 of the DID the caller dialled (null if unknown). Used by the admin webhook for tenant lookup. */
  calledNumber: string | null;
  /** Caller's line in E.164; may be redacted downstream. */
  callerNumber: string | null;
  roomName: string | null;
  callSid: string | null;
  stage: PipelineIncidentStage;
  /** Short error message — already stripped of PII by the caller. */
  errorMessage: string;
  /** Optional: model label the failure was attached to (e.g. `deepgram/flux-general`). */
  modelLabel?: string | null;
  /** Optional: stage retry counter if we have it, to help distinguish "instant fail" from "retry-exhausted". */
  retryable?: boolean | null;
  /** Whether the agent's SMS fallback actually fired. */
  smsFallbackSent?: boolean;
};

type ReportOutcome = {
  incidentId: string;
  webhookOk: boolean;
  webhookDetail: string;
};

/**
 * POST the incident to the admin webhook. Non-blocking beyond HTTP round-trip;
 * callers should still wrap this in `void` if they want pure fire-and-forget.
 */
export async function reportPipelineIncident(
  input: PipelineIncidentInput,
): Promise<ReportOutcome> {
  const incidentId = randomUUID();
  const base = (process.env.ADMIN_WEBHOOK_BASE_URL?.trim() || '').replace(/\/+$/, '');
  const secret = process.env.CLISTE_VOICE_WEBHOOK_SECRET?.trim();
  if (!base || !secret) {
    return {
      incidentId,
      webhookOk: false,
      webhookDetail:
        'ADMIN_WEBHOOK_BASE_URL or CLISTE_VOICE_WEBHOOK_SECRET not set; incident not forwarded to admin.',
    };
  }
  const url = `${base}/api/voice/pipeline-incident`;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        incident_id: incidentId,
        organization_id: input.organizationId,
        called_number: input.calledNumber,
        caller_number: input.callerNumber,
        room_name: input.roomName,
        call_sid: input.callSid,
        stage: input.stage,
        error_message: input.errorMessage,
        model_label: input.modelLabel ?? null,
        retryable: input.retryable ?? null,
        sms_fallback_sent: input.smsFallbackSent ?? false,
        occurred_at: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        incidentId,
        webhookOk: false,
        webhookDetail: `admin webhook ${res.status}`,
      };
    }
    return { incidentId, webhookOk: true, webhookDetail: 'ok' };
  } catch (e) {
    return {
      incidentId,
      webhookOk: false,
      webhookDetail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(to);
  }
}

/**
 * Send a single-line SMS with the booking link so the caller still converts
 * after the call drops. Best-effort — returns `{ ok: false }` on any missing
 * credentials / bad number.
 */
export async function sendPipelineFailureSms(input: {
  to: string | null;
  salonName: string;
  bookingUrl: string | null;
}): Promise<{ ok: boolean; detail: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from =
    process.env.TWILIO_SMS_FROM?.trim() || process.env.TWILIO_PHONE_NUMBER?.trim();
  const to = input.to?.trim() || '';
  const url = input.bookingUrl?.trim() || '';
  if (!sid || !token || !from) {
    return { ok: false, detail: 'twilio creds missing' };
  }
  if (!to || !to.startsWith('+') || to.length < 8) {
    return { ok: false, detail: 'caller number unknown or not E.164' };
  }
  if (!url) {
    return { ok: false, detail: 'no booking url configured for salon' };
  }
  const client = twilio(sid, token);
  const body = `Sorry, we had a line issue at ${input.salonName} — you can book here: ${url}`;
  try {
    await client.messages.create({ from, to, body });
    return { ok: true, detail: 'sent' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Last-ditch SIP-leg disconnect when the AgentSession is already dead and we
 * cannot rely on the session's own endCall path. Mirrors the over-quota
 * branch in agent.ts but as a standalone helper so the Error-event handler
 * can reach for it without pulling SalonAgentUserData.
 */
export async function forceDisconnectSipLeg(input: {
  roomName: string | null;
  callerIdentity: string | null;
}): Promise<{ ok: boolean; detail: string }> {
  const host = process.env.LIVEKIT_URL?.trim();
  const key = process.env.LIVEKIT_API_KEY?.trim();
  const secret = process.env.LIVEKIT_API_SECRET?.trim();
  const room = input.roomName?.trim() || '';
  const identity = input.callerIdentity?.trim() || '';
  if (!host || !key || !secret || !room || !identity) {
    return { ok: false, detail: 'missing livekit creds or room/identity' };
  }
  try {
    const httpsHost = host.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
    const client = new RoomServiceClient(httpsHost, key, secret);
    await client.removeParticipant(room, identity);
    return { ok: true, detail: 'removed' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Run the full soft-landing sequence:
 *   - webhook to /admin (fire-and-wait up to 4s)
 *   - SMS the caller (fire-and-wait up to ~10s via Twilio SDK)
 *   - remove SIP participant
 *
 * Safe to call from a session Error handler; all errors are swallowed and
 * logged. Returns a small summary so the caller can log it.
 */
export async function softLandPipelineFailure(input: {
  organizationId: string | null;
  calledNumber: string | null;
  callerNumber: string | null;
  callerIdentity: string | null;
  roomName: string | null;
  callSid: string | null;
  salonName: string;
  bookingUrl: string | null;
  stage: PipelineIncidentStage;
  errorMessage: string;
  modelLabel?: string | null;
  retryable?: boolean | null;
}): Promise<{
  incidentId: string;
  webhookOk: boolean;
  smsOk: boolean;
  disconnectOk: boolean;
  detail: string;
}> {
  const sms = await sendPipelineFailureSms({
    to: input.callerNumber,
    salonName: input.salonName,
    bookingUrl: input.bookingUrl,
  });
  const report = await reportPipelineIncident({
    organizationId: input.organizationId,
    calledNumber: input.calledNumber,
    callerNumber: input.callerNumber,
    roomName: input.roomName,
    callSid: input.callSid,
    stage: input.stage,
    errorMessage: input.errorMessage,
    ...(input.modelLabel !== undefined ? { modelLabel: input.modelLabel } : {}),
    ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    smsFallbackSent: sms.ok,
  });
  const disc = await forceDisconnectSipLeg({
    roomName: input.roomName,
    callerIdentity: input.callerIdentity,
  });
  console.warn(
    '[pipeline-incident] soft-landed',
    JSON.stringify({
      incidentId: report.incidentId,
      stage: input.stage,
      caller: maskPhone(input.callerNumber),
      sms: sms.ok ? 'sent' : sms.detail,
      webhook: report.webhookOk ? 'ok' : report.webhookDetail,
      disconnect: disc.ok ? 'ok' : disc.detail,
    }),
  );
  return {
    incidentId: report.incidentId,
    webhookOk: report.webhookOk,
    smsOk: sms.ok,
    disconnectOk: disc.ok,
    detail: `sms=${sms.detail}; webhook=${report.webhookDetail}; disc=${disc.detail}`,
  };
}
