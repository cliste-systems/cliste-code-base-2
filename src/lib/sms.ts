import twilio from 'twilio';

/** Prefer E.164; normalizes Irish national (08…) to +353… */
export function normalizePhoneE164(phone: string): string {
  const t = phone.trim();
  if (t.startsWith('+')) {
    return t;
  }
  const digits = t.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length >= 10 && digits.length <= 11) {
    return `+353${digits.slice(1)}`;
  }
  if (digits.startsWith('353') && digits.length >= 11) {
    return `+${digits}`;
  }
  return t;
}

export async function sendSms(
  to: string,
  body: string,
): Promise<{ ok: boolean; detail: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from =
    process.env.TWILIO_SMS_FROM?.trim() || process.env.TWILIO_PHONE_NUMBER?.trim();
  if (!sid || !token || !from) {
    return {
      ok: false,
      detail: 'Twilio env vars not set; read the link aloud or take a message.',
    };
  }
  const client = twilio(sid, token);
  await client.messages.create({ from, to, body });
  return { ok: true, detail: 'SMS sent.' };
}
