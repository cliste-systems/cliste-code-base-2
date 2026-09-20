import { DEMO_BANNED_AI_SLOP } from './demo_personality.js';

/** First names where STT often confuses spelling — confirm before icing. */
export const PHONETICALLY_AMBIGUOUS_FIRST_NAMES: readonly (readonly string[])[] = [
  ['brendan', 'brandon'],
  ['sean', 'shaun', 'shawn'],
  ['cathal', 'cahal'],
  ['niamh', 'neve', 'naoimh'],
  ['alan', 'allan', 'allen'],
  ['sara', 'sarah'],
  ['cian', 'kian'],
  ['darren', 'darragh', 'dara'],
];

export function normalizeFirstNameKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z'-]/g, '')
    .replace(/^-+|-+$/g, '');
}

export function isPhoneticallyAmbiguousFirstName(name: string): boolean {
  const key = normalizeFirstNameKey(name);
  if (!key) return false;
  return PHONETICALLY_AMBIGUOUS_FIRST_NAMES.some((group) => group.includes(key));
}

/** Letter-by-letter spelling: "B-R-E-N-D-A-N", "B R E N D A N", "B as in …". */
export function callerSpelledNameLetterByLetter(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;

  const hyphenated = raw.match(/\b([A-Za-z])(?:\s*[-–—]\s*([A-Za-z])){2,}\b/);
  if (hyphenated) return true;

  const spaced = raw.match(/\b([A-Za-z]\s+){3,}[A-Za-z]\b/);
  if (spaced) return true;

  if (/\b(as in|for [A-Za-z]|double [A-Za-z])\b/i.test(raw) && /\b[A-Za-z]\b/.test(raw)) {
    return true;
  }

  return false;
}

export function parseLetterSpelledName(text: string): string | null {
  const letters = [...text.toUpperCase().matchAll(/\b([A-Z])\b/g)].map((m) => m[1]!);
  const hyphenLetters = text
    .toUpperCase()
    .split(/[-–—]/)
    .map((part) => part.trim().replace(/[^A-Z]/g, ''))
    .filter((part) => part.length === 1);
  const merged = hyphenLetters.length >= 3 ? hyphenLetters : letters;
  if (merged.length < 3) return null;
  const name = merged.join('');
  return name.charAt(0) + name.slice(1).toLowerCase();
}

export function callerGaveFirstName(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || callerSpelledNameLetterByLetter(trimmed)) return null;

  const intro =
    trimmed.match(/^(?:it'?s|i'?m|my name is|this is|i am)\s+([A-Za-z][A-Za-z'-]{0,23})\b/i) ??
    trimmed.match(/^for\s+([A-Za-z][A-Za-z'-]{0,23})\b/i);
  if (intro?.[1]) return intro[1];

  if (/^[A-Za-z][A-Za-z'-]{0,23}[.!?]?$/.test(trimmed)) {
    return trimmed.replace(/[.!?]+$/, '');
  }
  return null;
}

/** Assistant asked for the caller's first name (any department — order, callback, cake, etc.). */
export function lastAssistantAskedCallerFirstName(text: string): boolean {
  return /\b(name on the cake|name would you like on the cake|first name for (?:the )?(?:order|collection|callback|message|pickup|pick-up)|your first name for (?:collection|the order|pickup|pick-up)|what(?:'s| is) (?:the )?first name|who(?:'s| is) (?:this )?for|collecting name|your name for (?:the )?(?:order|callback|collection))\b/i.test(
    text,
  );
}

/** @deprecated Use lastAssistantAskedCallerFirstName */
export const lastAssistantAskedCakeOrCollectionName = lastAssistantAskedCallerFirstName;

export function assistantAskedExplicitOrderConfirm(text: string): boolean {
  return /\b(is that (all )?correct|does that sound (right|ok|okay)|is that right|have i got that right|is that everything for you)\b/i.test(
    text,
  );
}

const TEAM_HANDOFF_PATTERNS: readonly RegExp[] = [
  /\bpass (?:that|it|this)(?: straight)? to the (?:bakery|butcher|deli|fish(?:monger)?|team|counter|department|store|service desk)\b/i,
  /\bpass (?:that|it|this) on to the team\b/i,
  /\bpass it straight (?:to|over)\b/i,
  /\b(?:i'?ll|i will) pass (?:that|it|this)\b/i,
  /\bget that logged for the team\b/i,
  /\b(?:grand|right|lovely|no bother)[,.]?\s*(?:i'?ll|i will) pass\b/i,
];

/** Assistant said they will pass the errand to staff or a department counter. */
export function assistantSpokeTeamHandoff(text: string): boolean {
  return TEAM_HANDOFF_PATTERNS.some((pattern) => pattern.test(text));
}

/** Handoff language before an explicit "Is that all correct?" in the same turn. */
export function assistantPrematureTeamHandoff(text: string): boolean {
  if (assistantAskedExplicitOrderConfirm(text)) return false;
  return assistantSpokeTeamHandoff(text);
}

/** @deprecated Use assistantPrematureTeamHandoff */
export const assistantPrematureBakeryHandoff = assistantPrematureTeamHandoff;

/** @deprecated Use assistantSpokeTeamHandoff */
export const assistantSpokeBakeryHandoff = assistantSpokeTeamHandoff;

export function assistantUsesBannedAiSlop(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  for (const phrase of DEMO_BANNED_AI_SLOP) {
    const needle = phrase.replace(/,$/, '').trim();
    if (!needle) continue;
    if (needle === 'sound' && /\bsound\b/.test(t)) return true;
    if (t.includes(needle)) return true;
  }
  return false;
}

export function buildAmbiguousNameConfirmSteer(name: string): string {
  const clean = name.trim() || 'that name';
  return (
    `The caller gave the name "${clean}" — it is often misheard (similar spellings exist). ` +
    `Ask ONE short confirm before you move on, e.g. "Just to get the spelling right — is that ${clean} with …?" or ask them to spell it once. ` +
    `Never say "thanks for that". One question, then stop.`
  );
}

export function buildPostConfirmSpellingSteer(spelledName: string | null): string {
  const nameBit = spelledName ? ` (${spelledName})` : '';
  return (
    `The caller spelled a name letter-by-letter${nameBit} after you already confirmed the order. ` +
    `Do NOT say "thanks for that" or ask "are you all sorted?" again. ` +
    `One brief line only — e.g. "Gotcha — ${spelledName ?? 'got it'}, noted." — then if they already said they're done, go straight to thanks-for-calling + endPhoneCall. No second wind-down.`
  );
}

export function buildPrematureTeamHandoffSteer(): string {
  return (
    'Do NOT pass this to the team or any department yet. Read back the full request with every key detail you captured, ' +
    'then ask ONE explicit confirm such as "Is that all correct?" — then stop and wait. ' +
    'Only after they say yes may you say you will pass it on, then move to ending the call.'
  );
}

/** @deprecated Use buildPrematureTeamHandoffSteer */
export const buildPrematureBakeryHandoffSteer = buildPrematureTeamHandoffSteer;

export function buildBannedSlopSteer(): string {
  return (
    'Never use call-centre filler (especially "thanks for that"). Rephrase in warm Irish desk English — one short line, then stop.'
  );
}

export const CAKE_AMBIGUOUS_NAME_PROMPT_BLOCK = `### Names — spelling matters (every errand)
- **Name on the cake**, **collecting name**, and **callback/order name** must be exact — wrong spelling wastes staff time.
- Common sound-alikes (**Brendan/Brandon**, **Sean/Shaun/Shawn**, **Sara/Sarah**, etc.) — if STT might have the wrong one, ask **one** short spelling check before you confirm (*"Just to get the spelling right — is that Brendan or Brandon?"*).
- Straightforward names (**Mary**, **John**, **Emma**, …) — do not over-ask.
- If they **spell it letter-by-letter**, note it — never reply with *"thanks for that"*.
- **Never** pass to the bakery or say the order is logged until they answer **yes** to your **"Is that all correct?"** summary.

### Confirm before handoff (every errand — all departments)
- **Orders, callbacks, complaints, stock checks, manager callbacks** — same rule: one read-back with the practical details, **"Is that all correct?"**, wait for **yes**, then you may say you will pass it to the team or department.
- **Never** say you will pass it on, log it, or hand it to a counter before they confirm.`;
