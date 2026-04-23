/**
 * Classify the caller's phone number so the agent can:
 *  - **Skip** asking for a phone when the line they are on is already a mobile
 *    that can receive the confirmation SMS — saves ~1–2 turns per call.
 *  - **Ask once** for an SMS-capable mobile when the line is an Irish landline
 *    or otherwise can't receive texts.
 *  - **Read the number back** in a natural grouping ("oh-eight-seven, …")
 *    instead of letting the TTS rattle off raw digits.
 *
 * Conservative defaults: when we cannot confidently classify (anonymous,
 * masked, garbled SIP identity), we return `unknown` and the agent asks for a
 * mobile the normal way.
 */

export type CallerLineKind = 'irish_mobile' | 'irish_landline' | 'international' | 'unknown';

export type CallerLineInfo = {
  /** Best-effort E.164 (e.g. +353871234567); empty string if unknown. */
  e164: string;
  /** What sort of line we think it is. */
  kind: CallerLineKind;
  /** Most common phrase a human would speak ("oh-eight-seven, four-five-six, seven-eight-nine-zero"). */
  spoken: string;
  /** Compact display ("087 456 7890"). */
  display: string;
  /** True when SMS will plausibly be deliverable (mobiles + most international numbers). */
  canReceiveSms: boolean;
  /** Short hint the prompt can use verbatim to steer the agent. */
  hint: string;
};

const IRISH_MOBILE_PREFIXES = new Set(['83', '85', '86', '87', '89']);

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/** Group digits in 3-3-4 (or close) for spoken read-back; keeps it natural for TTS. */
function groupDigits(digits: string): string[] {
  if (digits.length <= 4) {
    return [digits];
  }
  if (digits.length <= 7) {
    return [digits.slice(0, 3), digits.slice(3)];
  }
  if (digits.length <= 10) {
    return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
  }
  return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9), digits.slice(9)];
}

const DIGIT_WORD: Record<string, string> = {
  '0': 'oh',
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
};

/** Digit words with spaces inside a group — hyphens can make TTS say "hundred" or mash digits. */
function spokenFromGroups(groups: string[]): string {
  return groups
    .map((g) => g.split('').map((d) => DIGIT_WORD[d] ?? d).join(' '))
    .join(', ');
}

/**
 * Irish national mobile read-back: one spoken word per digit, comma-separated.
 * Stops TTS/LLM from turning "87" into "eighty-seven" or "271" into "two hundred seventy-one".
 * Example 872715938 → "oh, eight, seven, two, seven, one, five, nine, three, eight"
 */
function spokenIrishNationalDigitByDigit(localNineDigits: string): string {
  const words = localNineDigits.split('').map((d) => DIGIT_WORD[d] ?? d);
  return `oh, ${words.join(', ')}`;
}

/** Irish mobile national number (9 digits after +353): 08x xxx xxxx → 2+3+4 grouping. */
function groupIrishLocalDigits(local: string): string[] {
  if (local.length === 9 && local.startsWith('8')) {
    return [local.slice(0, 2), local.slice(2, 5), local.slice(5, 9)];
  }
  return groupDigits(local);
}

function classifyIrishE164(local: string): { kind: CallerLineKind; canReceiveSms: boolean } {
  // local = digits AFTER the +353 country code, with the leading 0 already stripped.
  // Irish mobiles: 8x where x ∈ {3,5,6,7,9}. Everything else is treated as a landline.
  if (local.length === 9 && local.startsWith('8')) {
    const next = local.slice(1, 2); // '3'/'5'/'6'/'7'/'9' for mobiles
    if (IRISH_MOBILE_PREFIXES.has(`8${next}`)) {
      return { kind: 'irish_mobile', canReceiveSms: true };
    }
  }
  return { kind: 'irish_landline', canReceiveSms: false };
}

/**
 * Inspect a raw caller identifier (E.164, "sip_+353…", or attribute string) and
 * return everything the agent needs to handle the phone-capture step efficiently.
 */
/**
 * Salon directory / voice line as customers should see it in SMS (not the Twilio SMS-sender ID).
 * Irish numbers → "087 271 5938"; US → "+1 415 …"; otherwise returns +E.164 when possible.
 */
export function formatSalonPhoneForCustomerSms(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  const digits = t.replace(/\D/g, '');
  if (!digits) return t;

  let d = digits;
  if (d.startsWith('0') && d.length >= 10 && d.length <= 11 && !d.startsWith('00')) {
    d = `353${d.slice(1)}`;
  }

  if (d.startsWith('353') && d.length >= 11) {
    const local = d.slice(3);
    if (local.length === 9) {
      return `0${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}`;
    }
    return `+${d}`;
  }

  if (d.length === 11 && d.startsWith('1')) {
    const n = d.slice(1);
    return `+1 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }

  if (d.length === 12 && d.startsWith('44')) {
    return `+${d}`;
  }

  if (t.startsWith('+')) return t;
  return t;
}

export function classifyCallerLine(raw: string | null | undefined): CallerLineInfo {
  const trimmed = (raw ?? '').trim();
  const lower = trimmed.toLowerCase();

  // Anonymous/withheld lines come through as 'anonymous', 'restricted', 'unknown',
  // 'private', 'unavailable', or empty. Treat all of these as unknown.
  if (
    !trimmed ||
    lower === 'unknown' ||
    lower === 'anonymous' ||
    lower === 'restricted' ||
    lower === 'private' ||
    lower === 'unavailable' ||
    lower.includes('blocked')
  ) {
    return {
      e164: '',
      kind: 'unknown',
      spoken: '',
      display: '',
      canReceiveSms: false,
      hint: 'Caller line is withheld / unknown — ask them for a mobile number for the confirmation text the normal way.',
    };
  }

  // Strip "sip_" / "sip:" prefixes occasionally seen on participant identities.
  let candidate = trimmed.replace(/^sip[:_]/i, '');

  // Promote raw national digits to E.164 where we can guess the country.
  if (!candidate.startsWith('+')) {
    const d = digitsOnly(candidate);
    if (!d) {
      return {
        e164: '',
        kind: 'unknown',
        spoken: '',
        display: '',
        canReceiveSms: false,
        hint: 'Caller line could not be parsed — ask for an SMS-capable mobile the normal way.',
      };
    }
    if (d.startsWith('353') && d.length >= 11) {
      candidate = `+${d}`;
    } else if (d.startsWith('0') && (d.length === 10 || d.length === 11)) {
      candidate = `+353${d.slice(1)}`;
    } else if (d.length >= 10) {
      // Best effort — assume international; reader still sees the raw digits.
      candidate = `+${d}`;
    } else {
      return {
        e164: '',
        kind: 'unknown',
        spoken: '',
        display: '',
        canReceiveSms: false,
        hint: 'Caller line could not be parsed — ask for an SMS-capable mobile the normal way.',
      };
    }
  }

  const e164 = candidate;

  if (e164.startsWith('+353')) {
    const local = e164.slice(4);
    const groups = groupIrishLocalDigits(local);
    const cls = classifyIrishE164(local);
    const display =
      groups.length >= 1 ? `0${groups[0]}${groups.length > 1 ? ` ${groups.slice(1).join(' ')}` : ''}` : `0${local}`;
    const spoken =
      local.length === 9 && cls.kind === 'irish_mobile'
        ? spokenIrishNationalDigitByDigit(local)
        : `oh ${spokenFromGroups(groups)}`;
    return {
      e164,
      kind: cls.kind,
      spoken,
      display,
      canReceiveSms: cls.canReceiveSms,
      hint:
        cls.kind === 'irish_mobile'
          ? `Caller line is an Irish mobile (${display}). Confirm it for the SMS in one short turn — do NOT ask "what's your number" from scratch.`
          : `Caller line is an Irish landline (${display}); landlines cannot receive SMS. Ask once for an SMS-capable mobile (08x), and use that for the confirmation text.`,
    };
  }

  // Non-Irish: best-effort. Most international callers are on a mobile already,
  // so default to "mobile-like" but tell the agent to confirm before texting.
  const local = e164.replace(/^\+/, '');
  const groups = groupDigits(local);
  const spoken = spokenFromGroups(groups);
  const display = `+${groups.join(' ')}`;
  return {
    e164,
    kind: 'international',
    spoken,
    display,
    canReceiveSms: true,
    hint: `Caller line is international (${display}). Confirm it can receive SMS in one short turn before sending the confirmation text.`,
  };
}
