/** Deterministic retail handlers for Kavanaghs-style conversational lines (9508). */

const NOT_A_NAME = new Set([
  'yes',
  'yeah',
  'yep',
  'no',
  'nope',
  'thanks',
  'thank',
  'hello',
  'hi',
  'hey',
  'bye',
  'goodbye',
  'okay',
  'ok',
  'grand',
  'lovely',
  'perfect',
  'sure',
  'right',
  'sorry',
  'please',
  'there',
  'here',
  'nothing',
  'everything',
]);

function normalizeRetailSpeech(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function capitalizeName(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** Stock, availability, or price questions — handled programmatically on stable retail lines. */
export function callerSoundsLikeStockOrPriceQuestion(text: string): boolean {
  const t = normalizeRetailSpeech(text);
  if (!t) return false;

  if (/\b(price|prices|cost|how much|how dear|what does .* cost)\b/.test(t)) {
    return true;
  }
  if (/\b(in stock|out of stock|have any|have you got|do you have|do ye have|got any|any left|still have|available)\b/.test(t)) {
    return true;
  }
  if (/\bstock\b/.test(t)) {
    return true;
  }
  return false;
}

/** Extract a caller first name from speech — optional single-word match when awaiting name. */
export function extractRetailCallerFirstName(
  text: string,
  opts?: { awaitingName?: boolean },
): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const explicitPatterns = [
    /\b(?:my name is|i am|i'?m|it'?s|this is|call me|name'?s)\s+([a-z][a-z'-]{1,30})\b/i,
    /\b(?:i'?m|it'?s)\s+([a-z][a-z'-]{1,30})\b/i,
  ];
  for (const pattern of explicitPatterns) {
    const match = trimmed.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate && !NOT_A_NAME.has(candidate.toLowerCase())) {
      return capitalizeName(candidate);
    }
  }

  if (opts?.awaitingName) {
    const single = trimmed.match(/^([a-z][a-z'-]{1,30})$/i);
    const candidate = single?.[1]?.trim();
    if (candidate && !NOT_A_NAME.has(candidate.toLowerCase())) {
      return capitalizeName(candidate);
    }
  }

  return null;
}

export function buildRetailStockAskNameLine(): string {
  return "I can't check that on the phone — I can ask the team to ring you back. What's your first name?";
}

export function buildRetailAskNameOnlyLine(): string {
  return "What's your first name?";
}

export function buildRetailCallbackConfirmationLine(firstName: string): string {
  const name = firstName.trim() || 'there';
  return `Thanks ${name} — I've passed that to the team and they'll ring you back.`;
}

/** Confirm caller ID on file — never ask them to read their number out. */
export function buildRetailCallbackNumberConfirmLine(displayNumber: string): string {
  const number = displayNumber.trim() || 'this number';
  return `Is ${number} the best number to contact you on?`;
}

/** takeCallbackMessage validation failures that should trigger programmatic name recovery. */
export function isTakeCallbackNameValidationError(output: string): boolean {
  const t = output.toLowerCase();
  return (
    t.includes('ask for their name') ||
    t.includes('callername') ||
    t.includes('too small') ||
    t.includes('provide a name')
  );
}

export function formatRetailStableBehaviourForPrompt(): string {
  return `## Retail phone — stable mode

- Answer in **one short sentence**.
- **Never** call takeCallbackMessage until the caller has said their first name in speech.
- **Never** ask *are you all sorted?* right after answering hours — wait for them.
- **Never** say *grand*.
- Stock, prices, and availability: you cannot confirm on the phone — say the team can ring them back and ask for their first name.
- When caller ID is on file for a callback or order: confirm with *Is [their number] the best number to contact you on?* — **never** ask them to read out or give their mobile number.
- When they say they are finished (*that's everything*, *thanks that's all*): ask **once** if there is anything else you can help with — wait for their answer — then one warm thanks-for-calling close. Do **not** call endPhoneCall until after that anything-else question.`;
}
