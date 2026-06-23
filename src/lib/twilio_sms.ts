import twilio from 'twilio';

import {
  ensureTwilioIe1MessagingRegion,
  ie1SmsConfigured,
  isIrishE164,
  resolveIe1Credentials,
} from './twilio_ie_messaging.js';

export type TwilioSmsSendOptions = {
  organizationId?: string;
  purpose?: string;
  fromE164?: string;
};

export function twilioSmsConfigured(): boolean {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from =
    process.env.TWILIO_SMS_FROM?.trim() ||
    process.env.TWILIO_PHONE_NUMBER?.trim();
  return Boolean(sid && token && (from || ie1SmsConfigured()));
}

/** Log + succeed without Twilio — full booking flow (linkSent, spoken confirmation). */
export function caraSmsDryRunEnabled(): boolean {
  return process.env.CARA_SMS_DRY_RUN?.trim().toLowerCase() === 'true';
}

function platformSmsFrom(): string | null {
  return (
    process.env.TWILIO_SMS_FROM?.trim() ||
    process.env.TWILIO_PHONE_NUMBER?.trim() ||
    null
  );
}

function us1Client(): twilio.Twilio | null {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) return null;
  return twilio(sid, token);
}

function ie1Client(): twilio.Twilio | null {
  const creds = resolveIe1Credentials();
  if (!creds) return null;
  return twilio(creds.apiKeySid, creds.apiKeySecret, {
    accountSid: creds.accountSid,
    edge: 'dublin',
    region: 'ie1',
  });
}

function ie1AlphaSender(): string | null {
  return process.env.TWILIO_IE1_ALPHA_SENDER?.trim() || null;
}

function ie1MessagingServiceSid(): string | null {
  return process.env.TWILIO_IE1_MESSAGING_SERVICE_SID?.trim() || null;
}

function isNotSmsCapableError(message: string): boolean {
  return /21661|not SMS-capable|not sms capable/i.test(message);
}

async function sendViaIe1(
  from: string,
  to: string,
  body: string,
): Promise<{ ok: true; from: string } | { ok: false; message: string }> {
  const client = ie1Client();
  if (!client) {
    return {
      ok: false,
      message:
        'TWILIO_IE1_AUTH_TOKEN or TWILIO_IE1_API_KEY/SECRET is required to send SMS from Irish (+353) numbers — create IE1 credentials in Twilio Console (Ireland region).',
    };
  }

  const region = await ensureTwilioIe1MessagingRegion(from);
  if (!region.ok) {
    console.warn('[sms] IE1 region ensure failed', from, region.message);
  }

  const trimmedTo = to.trim();

  try {
    const message = await client.messages.create({ from, to: trimmedTo, body });
    return { ok: true, from: message.from ?? from };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isNotSmsCapableError(msg)) {
      return { ok: false, message: msg };
    }

    const messagingServiceSid = ie1MessagingServiceSid();
    if (messagingServiceSid) {
      try {
        const message = await client.messages.create({
          messagingServiceSid,
          to: trimmedTo,
          body,
        });
        return { ok: true, from: message.from ?? messagingServiceSid };
      } catch (mgErr) {
        const mgMsg = mgErr instanceof Error ? mgErr.message : String(mgErr);
        console.warn('[sms] IE1 messaging service fallback failed', mgMsg);
      }
    }

    const alphaSender = ie1AlphaSender();
    if (alphaSender) {
      try {
        const message = await client.messages.create({
          from: alphaSender,
          to: trimmedTo,
          body,
        });
        return { ok: true, from: message.from ?? alphaSender };
      } catch (alphaErr) {
        const alphaMsg =
          alphaErr instanceof Error ? alphaErr.message : String(alphaErr);
        return {
          ok: false,
          message: `${msg}; alpha fallback failed: ${alphaMsg}`,
        };
      }
    }

    return {
      ok: false,
      message: `${msg} — set TWILIO_IE1_ALPHA_SENDER or TWILIO_IE1_MESSAGING_SERVICE_SID for Irish voice-only DIDs.`,
    };
  }
}

async function sendViaUs1(
  from: string,
  to: string,
  body: string,
): Promise<{ ok: true; from: string } | { ok: false; message: string }> {
  const client = us1Client();
  if (!client) {
    return { ok: false, message: 'Twilio not configured' };
  }
  try {
    const message = await client.messages.create({ from, to: to.trim(), body });
    return { ok: true, from: message.from ?? from };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
}

/** Direct Twilio SMS from the voice worker. Irish org DIDs always use IE1 — never UK fallback. */
export async function sendTwilioSms(
  to: string,
  body: string,
  options?: TwilioSmsSendOptions,
): Promise<{ ok: true; from: string } | { ok: false; message: string }> {
  const platformFrom = platformSmsFrom();
  const preferredFrom = options?.fromE164?.trim() || platformFrom;
  if (!preferredFrom) {
    return { ok: false, message: 'Twilio from number not configured' };
  }

  if (isIrishE164(preferredFrom)) {
    return sendViaIe1(preferredFrom, to, body);
  }

  return sendViaUs1(preferredFrom, to, body);
}
