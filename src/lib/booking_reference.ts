/** 8-char code, easy to read over the phone (no I, O, 0, 1). */
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateBookingReference(): string {
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += REF_CHARS[Math.floor(Math.random() * REF_CHARS.length)]!;
  }
  return s;
}

/** Match worker + dashboard behaviour for customer phone storage and lookup. */
export function normalizeCustomerPhoneE164(phone: string): string {
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

export function customerPhonesMatch(a: string, b: string): boolean {
  return normalizeCustomerPhoneE164(a) === normalizeCustomerPhoneE164(b);
}
