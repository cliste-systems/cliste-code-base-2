const TWILIO_ROUTES_V3_BASE = 'https://routes.twilio.com/v3/PhoneNumbers';

function twilioAuthHeader(): string | null {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) return null;
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

/** Irish org DIDs must use Twilio IE1 for outbound SMS (EU data residency). */
export function isIrishE164(e164: string): boolean {
  return e164.trim().startsWith('+353');
}

/**
 * Configure a Twilio number for EU SMS (IE1). Safe to call repeatedly.
 * Uses US1 account credentials (routes API is global).
 */
export async function ensureTwilioIe1MessagingRegion(
  e164: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const auth = twilioAuthHeader();
  if (!auth) {
    return { ok: false, message: 'Twilio not configured' };
  }

  const encoded = encodeURIComponent(e164);
  const res = await fetch(`${TWILIO_ROUTES_V3_BASE}/${encoded}`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ messagingRegion: 'ie1' }).toString(),
  });

  if (res.status >= 200 && res.status < 300) {
    return { ok: true };
  }

  let detail = res.statusText;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) detail = body.message;
  } catch {
    /* ignore */
  }

  return { ok: false, message: detail };
}

export type Ie1TwilioCredentials = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
};

/** IE1 requires region-specific API keys — US1 auth token will not work on IE1 APIs. */
export function resolveIe1Credentials(): Ie1TwilioCredentials | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  if (!accountSid) return null;

  const apiKeySid = process.env.TWILIO_IE1_API_KEY?.trim();
  const apiKeySecret = process.env.TWILIO_IE1_API_SECRET?.trim();
  if (apiKeySid && apiKeySecret) {
    return { accountSid, apiKeySid, apiKeySecret };
  }

  const ie1AuthToken = process.env.TWILIO_IE1_AUTH_TOKEN?.trim();
  if (ie1AuthToken) {
    return { accountSid, apiKeySid: accountSid, apiKeySecret: ie1AuthToken };
  }

  return null;
}

export function ie1SmsConfigured(): boolean {
  return resolveIe1Credentials() !== null;
}
