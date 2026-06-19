/** Normalize caller numbers for SMS tools and blocklist (Irish national → E.164). */
export function normalizePhoneE164(phone: string): string {
  const t = phone.trim();
  if (t.startsWith('+')) return t;
  const digits = t.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length >= 10 && digits.length <= 11) {
    return `+353${digits.slice(1)}`;
  }
  if (digits.startsWith('353') && digits.length >= 11) {
    return `+${digits}`;
  }
  return t;
}
