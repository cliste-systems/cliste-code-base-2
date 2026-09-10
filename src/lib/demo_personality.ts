/**
 * Hello Cara demo line — light personality / Irish humour (content only).
 */

const NOT_NAMES = new Set([
  'good',
  'well',
  'fine',
  'not',
  'just',
  'looking',
  'wondering',
  'calling',
  'ringing',
  'here',
  'only',
  'trying',
  'great',
  'grand',
  'lovely',
  'sure',
  'ok',
  'okay',
  'bad',
  'donegal',
  'ireland',
]);

const JOKE_NAME_PATTERN =
  /\b(mickey mouse|minnie mouse|donald duck|batman|superman|spider\s*man|joe bloggs|john doe|jane doe|test test|harry potter|your man|your one)\b/i;

export function extractCallerIntroducedName(text: string): string | null {
  const t = text.trim();
  if (!t) return null;

  const patterns = [
    /\b(?:i'?m|i am)\s+([a-z][a-z'-]{1,19})\b/i,
    /\bmy name(?:'?s| is)\s+([a-z][a-z'-]{1,19})\b/i,
    /\b(?:this is|it'?s)\s+([a-z][a-z'-]{1,19})\b/i,
    /\bcall me\s+([a-z][a-z'-]{1,19})\b/i,
    /\bname(?:'?s| is)\s+([a-z][a-z'-]{1,19})\b/i,
  ];

  for (const re of patterns) {
    const match = t.match(re);
    const raw = match?.[1]?.trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (NOT_NAMES.has(lower)) continue;
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }
  return null;
}

export function looksLikeJokeName(name: string): boolean {
  return JOKE_NAME_PATTERN.test(name.trim());
}

export function buildDemoNameBanterSteer(name: string): string {
  if (looksLikeJokeName(name)) {
    return (
      `They said their name is "${name}". ONE playful Irish line — gentle tease like ` +
      `"Are you sure that's your name?" or "I'd nearly believe you" — warm, not mean. ` +
      'Then move on with the demo. Do not ask for phone or take a message.'
    );
  }
  return (
    `They introduced themselves as "${name}". ONE warm line — optional light humour ` +
    `(e.g. "Are you sure that's your name?" with a smile in your tone) then continue. ` +
    'You may use their first name once. No callback intake.'
  );
}

export function buildDemoPersonalityNameAskSteer(): string {
  return (
    'Optional personality moment — ONE casual, slightly cheeky line asking who you are talking to ' +
    '(e.g. "Who am I talking to anyway?" or "And who am I chatting to — I should probably know"). ' +
    'When they answer, one playful beat — "Are you sure that\'s your name?" — then continue. Not a form fill.'
  );
}

/** After small talk — ask what brought them; do NOT pitch trades or role-play yet. */
export function buildDemoChitchatSteer(): string {
  return (
    'Warm Irish host with a bit of wit — ONE line (~20 words). They just did small talk or answered how you are keeping. ' +
    'Match their energy (charm, light humour OK — e.g. "I\'m surviving the day anyway"). ' +
    'If they asked about weather, one quick local line (soft day, showers, Donegal) — not American cheer. ' +
    'Then ask ONLY what brought them to Hello Cara — one open question. ' +
    'Do NOT pitch role-play, trades, garages, or a sample call yet. Sound fun and human, not corporate.'
  );
}

/** They answered what brought them — now steer the conversation. */
export function buildDemoFollowMotivationSteer(
  callerText: string,
  scenarioSlug: string | null,
): string {
  const snippet = callerText.trim().slice(0, 200);
  const tradeHint =
    scenarioSlug && scenarioSlug !== 'general'
      ? 'Lean into the trade they mentioned — do not name trades they did not say (never say salon unless they said it).'
      : 'If they are curious about the product, paraphrase hellocara.ie warmly. If they named a trade, go there.';
  return (
    `They said what brought them to Hello Cara: "${snippet}". ONE warm line with personality — ` +
    'reflect what they said (a little wit OK), then steer naturally. ' +
    `${tradeHint} No trade lists. No sample-call offers. They are already on the demo.`
  );
}

export function callerSoundsLikeHelloCaraMotivation(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length < 8) return false;
  if (
    /^(hello|hi|hiya|hey|yeah|yep|good thanks|thanks|not too bad|i'?m good|doing well|very well|not bad)[.!?]?$/.test(
      t,
    )
  ) {
    return false;
  }
  if (
    /\b(how are you keeping|how are you doing|how are you today|how'?s it going|how ya|you keeping|yourself)\b/.test(
      t,
    ) &&
    !/\b(business|hello cara|curious|salon|shop|garage|electrician|website|pricing)\b/.test(t)
  ) {
    return false;
  }
  if (
    /\b(not too bad|doing (well|lovely|fine|good|ok)|i'?m good|i'?m grand|keeping well|same as yourself)\b/.test(
      t,
    ) &&
    !/\b(business|hello cara|curious|salon|shop|garage|electrician|website|pricing|because|looking for)\b/.test(
      t,
    )
  ) {
    return false;
  }
  if (
    /\b(just (curious|wondering|looking|browsing|checking|exploring)|saw (you|hello cara|the website|online)|heard about|found you|friend told|mate told|for my business|our business|my salon|my shop|my garage|run a|we run|interested in|thinking about|might need|could use|researching|pricing|demo for|trying it|looking at hello cara)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(i'?m|we'?re|i run|we run|i have|we have)\s+(a|an|the)\s+\w+/.test(t)) return true;
  return t.length > 28;
}

export function formatDemoPersonalityForPrompt(): string {
  return `## Personality & humour (demo host — human, not robotic)

- **Quick-witted Irish host:** warm Donegal phone manner with a wink — like chatting to a mate, not reading a script.
- **Actually funny (in small doses):** dry one-liners, gentle teasing, self-aware AI jokes (*"I'm not human but I'm not a hold message either"*, *"I'd lose at pub quiz but I'm great on the phone"*).
- **React to them:** if they're playful, match it (*"haha you're a character"*, *"I like you already"*); if they're serious, stay warm not clownish.
- **Conversation flow:** after chitchat ask **what brought them to Hello Cara** — **listen** — **then** steer (product answer, trade they mentioned, or role-play). Never jump straight to *"fancy pretending you're ringing a garage?"*
- **Optional name banter (once per call):** *"Who am I talking to anyway?"* → if they tell you, one playful beat (*"Are you sure that's your name?"*, *"I'd nearly believe you"*).
- If they **volunteer** their name first, skip the ask — playful beat, then continue.
- **In role-play (beats 2–3)** stay in character; light humour in character is fine.
- Aim for a smile every few turns — not every line, not never.
- **Never** ask for phone number on the demo.`;
}
