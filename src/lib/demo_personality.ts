/**
 * Hello Cara demo line — light personality / Irish humour (content only).
 */

/** Phrases that scream AI / call-centre — never in speech or steers as examples to copy. */
export const DEMO_BANNED_AI_SLOP = [
  'how can I assist',
  'how may I assist',
  'i would be delighted',
  "i'd be delighted",
  'absolutely',
  'certainly',
  'just a quick heads-up',
  'ah, perfect',
  'great question',
  'thanks for sharing',
  'i understand your',
  'is there anything else i can help',
  'please provide',
  'as an ai',
  'as a language model',
  'happy to help you with that',
  'assist you today',
] as const;

function pickDemoPhraseIndex(seed: string, count: number): number {
  if (count <= 1) return 0;
  let h = 2166136261;
  const input = seed.trim().toLowerCase() || 'demo';
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % count;
}

function formatDemoAntiSlopSteerBlock(): string {
  return (
    'Sound like a real person on an Irish phone call — not a chatbot, hold message, or American customer-service voice. ' +
    'One short line (8–18 words). React to what they said; do not perform helpfulness. ' +
    `Banned: ${DEMO_BANNED_AI_SLOP.slice(0, 8).join(', ')}, trade lists, stacked questions.`
  );
}

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
  'keeping',
  'doing',
  'very',
  'feeling',
  'having',
  'getting',
  'going',
  'speaking',
  'talking',
  'saying',
  'asking',
  'there',
  'today',
  'yeah',
  'yep',
]);

const JOKE_NAME_PATTERN =
  /\b(mickey mouse|minnie mouse|donald duck|batman|superman|spider\s*man|joe bloggs|john doe|jane doe|test test|harry potter|your man|your one)\b/i;

/** Any reasonable first-name token STT might return — not a fixed name list. */
const NAME_TOKEN = "[a-z][a-z'\\-]{1,24}";

const DEMO_NAME_BLOCKLIST = new Set([
  ...NOT_NAMES,
  'cara',
  'hello',
  'hi',
  'hey',
  'thanks',
  'thank',
  'yes',
  'no',
  'nope',
  'nah',
  'right',
  'sorry',
  'please',
]);

export function formatDemoFirstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? name.trim();
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/** True when a token looks like a real first name, not chitchat or greeting debris. */
export function isPlausibleDemoFirstName(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 25) return false;
  if (!/^[a-z][a-z'-]*$/i.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  if (DEMO_NAME_BLOCKLIST.has(lower)) return false;
  if (/^(mr|mrs|ms|dr)\b/i.test(trimmed)) return false;
  return true;
}

function normalizeNameCandidate(raw: string): string | null {
  if (!isPlausibleDemoFirstName(raw)) return null;
  return formatDemoFirstName(raw);
}

function firstNameMatch(text: string, re: RegExp): string | null {
  const match = text.match(re);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  return normalizeNameCandidate(raw);
}

/** Scan common ways callers introduce themselves — works for any plausible first name. */
function scanDemoCallerName(text: string): string | null {
  const t = text
    .trim()
    .replace(/^(uh|um|er|ah|well|so|like)[,\s]+/i, '')
    .trim();
  if (!t) return null;

  const patterns = [
    new RegExp(`\\b(?:i'?m|i am)\\s+(${NAME_TOKEN})\\b`, 'i'),
    new RegExp(`\\bmy name(?:'?s| is)\\s+(${NAME_TOKEN})\\b`, 'i'),
    new RegExp(`\\b(?:this is|it'?s)\\s+(${NAME_TOKEN})\\b`, 'i'),
    new RegExp(`\\bcall me\\s+(${NAME_TOKEN})\\b`, 'i'),
    new RegExp(`\\bname(?:'?s| is)\\s+(${NAME_TOKEN})\\b`, 'i'),
    new RegExp(`\\b(?:i'?m|i am)\\s+called\\s+(${NAME_TOKEN})\\b`, 'i'),
    new RegExp(`\\b(?:you'?re\\s+)?(?:speaking|talking) to\\s+(${NAME_TOKEN})\\b`, 'i'),
    new RegExp(`\\b(?:you'?re\\s+)?(?:speaking|talking) with\\s+(${NAME_TOKEN})\\b`, 'i'),
    new RegExp(`\\bthrough to\\s+(${NAME_TOKEN})\\b`, 'i'),
    new RegExp(`\\b(?:i'?m|this is|it'?s)\\s+(${NAME_TOKEN})\\s+here\\b`, 'i'),
    new RegExp(`\\b(${NAME_TOKEN})\\s+here\\b`, 'i'),
  ];

  for (const re of patterns) {
    const name = firstNameMatch(t, re);
    if (name) return name;
  }
  return null;
}

export function extractDemoCallerNameResponse(text: string): string | null {
  const scanned = scanDemoCallerName(text);
  if (scanned) return scanned;

  const bare = text.trim().replace(/[.!?,]+$/g, '').trim();
  if (/^[a-z][a-z'-]{1,24}$/i.test(bare)) {
    return normalizeNameCandidate(bare);
  }

  const trailing = text.match(new RegExp(`\\b(?:uh|um|er|ah|well|so|like)[,\\s]+(${NAME_TOKEN})\\s*$`, 'i'));
  if (trailing?.[1]) {
    return normalizeNameCandidate(trailing[1]);
  }

  return null;
}

export function extractCallerIntroducedName(text: string): string | null {
  return scanDemoCallerName(text);
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
    `They introduced themselves as "${name}". ONE natural line — use their first name once if it fits, ` +
    'then move on. No "perfect", no "delighted", no callback intake.'
  );
}

const DEMO_CONSENT_REPLIES = [
  (n: string) => `Lovely, ${n} — we record these calls, is that alright?`,
  (n: string) => `${n}, quick one — the call gets recorded, happy enough with that?`,
  (n: string) => `Sound, ${n}. Calls here get recorded — is that okay?`,
] as const;

/** Fixed turn-2 reply after the caller gives their name on the demo line. */
export function buildDemoRecordingConsentReply(name: string, seed?: string): string {
  const firstName = formatDemoFirstName(name);
  const idx = pickDemoPhraseIndex(seed ?? firstName, DEMO_CONSENT_REPLIES.length);
  return DEMO_CONSENT_REPLIES[idx]!(firstName);
}

/** Fixed ack after caller answers "how are you keeping?" — no follow-up question same turn. */
export function buildDemoWellbeingAckReply(seed?: string): string {
  const lines = [
    'Not too bad at all, thanks.',
    'Ah, not too bad, thanks for asking.',
    'Yeah, not too bad — thanks.',
  ] as const;
  const idx = pickDemoPhraseIndex(seed ?? 'wellbeing-ack', lines.length);
  return lines[idx]!;
}

const DEMO_AFTER_CONSENT_REPLIES = [
  () => 'How are you keeping?',
  () => 'How are you keeping yourself?',
  () => 'And yourself — how are you keeping?',
] as const;

/** Fixed reply after the caller agrees to recording on the demo line. */
export function buildDemoAfterConsentReply(name: string, seed?: string): string {
  const firstName = formatDemoFirstName(name);
  const idx = pickDemoPhraseIndex(`${firstName}:${seed ?? 'after-consent'}`, DEMO_AFTER_CONSENT_REPLIES.length);
  return DEMO_AFTER_CONSENT_REPLIES[idx]!();
}

const DEMO_AFTER_CONSENT_ACKS = [
  (n: string) => `Sound, ${n}.`,
  (n: string) => `Lovely, ${n}.`,
  (n: string) => `Right, ${n}.`,
] as const;

/** Short ack when the caller already answered how they are keeping before consent finished. */
export function buildDemoAfterConsentAckOnly(name: string, seed?: string): string {
  const firstName = formatDemoFirstName(name);
  const idx = pickDemoPhraseIndex(`${firstName}:${seed ?? 'ack'}`, DEMO_AFTER_CONSENT_ACKS.length);
  return DEMO_AFTER_CONSENT_ACKS[idx]!(firstName);
}

/** Single steer when consent is granted but chitchat was deferred — avoids programmatic + steer double-speak. */
export function buildDemoAfterConsentDeferredSteer(name: string, deferredChitchat: string): string {
  const firstName = formatDemoFirstName(name);
  const snippet = deferredChitchat.trim().slice(0, 200);
  const ack = buildDemoAfterConsentAckOnly(firstName, deferredChitchat);
  return (
    `Recording consent is done. Start with something like "${ack}" then ONE natural line responding to: "${snippet}". ` +
    `${formatDemoAntiSlopSteerBlock()} Do NOT ask "how are you keeping?" again.`
  );
}

/** Fixed programmatic reminder after consent steer cap — no further LLM consent retries. */
export function buildDemoRecordingConsentProgrammaticReminder(): string {
  return 'Before we chat — is recording the call alright with you?';
}

export function buildDemoRecordingConsentReminderSteer(): string {
  return (
    'They chatted but have not confirmed recording yet. ONE natural line — brief ack of their chat, ' +
    'then ask again if recording is alright. No stiff legal wording, no "heads-up".'
  );
}

/** @deprecated Use buildDemoRecordingConsentReply */
export function buildDemoAfterNameReply(name: string): string {
  return buildDemoRecordingConsentReply(name);
}

export function buildDemoRecordingConsentRetrySteer(): string {
  return (
    'They did not clearly answer about recording. ONE natural line — ask again if recording is alright. ' +
    'No business questions yet, no repeat greeting, no call-centre tone.'
  );
}

export function buildDemoRecordingDeclineSteer(): string {
  return (
    'They declined recording. ONE understanding line — no pressure. Mention we can still chat, ' +
    'ask gently once more if they are happy to continue with recording on. Sound human, not scripted.'
  );
}

/** Programmatic name re-ask when LLM steers did not land — avoids infinite loops. */
export function buildDemoAskNameAgainReply(): string {
  return "Sorry, I missed that — who's this?";
}

/** Opening phase — still waiting for the caller's name. */
export function buildDemoAskNameSteer(callerText: string, opts?: { audioCheck?: boolean }): string {
  if (opts?.audioCheck) {
    return (
      'They asked if you can hear them. ONE natural line — yes you can hear them, then ask who is on the line. ' +
      'No repeat greeting, no corporate tone.'
    );
  }
  const snippet = callerText.trim().slice(0, 200);
  return (
    `They said: "${snippet}" but no name yet. ONE natural line — brief ack if needed, then ask who is on the line. ` +
    'Do not answer their question yet, do not repeat the opening, do not sound like a chatbot.'
  );
}

/** @deprecated Use buildDemoAskNameSteer */
export function buildDemoPreNameSteer(opts?: { audioCheck?: boolean }): string {
  return buildDemoAskNameSteer('', opts);
}

export function buildDemoPersonalityNameAskSteer(): string {
  return (
    'Optional personality moment — ONE casual, slightly cheeky line asking who you are talking to ' +
    '(e.g. "Who am I talking to anyway?" or "And who am I chatting to — I should probably know"). ' +
    'When they answer, one playful beat — "Are you sure that\'s your name?" — then continue. Not a form fill.'
  );
}

/** Natural conversational reply — acknowledge first, do not rush business. */
export function buildDemoConversationalReplySteer(callerText: string): string {
  const snippet = callerText.trim().slice(0, 200);
  return (
    `They said: "${snippet}". ${formatDemoAntiSlopSteerBlock()} ` +
    'Often no question — let them lead. No trade lists, no product pitch, no "what brought you here" yet.'
  );
}

/** After small talk — stay conversational; only move toward product when they clearly steer there. */
export function buildDemoChitchatSteer(): string {
  return buildDemoConversationalReplySteer('small talk or how are you keeping reply');
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
    `They said: "${snippet}". ONE natural line — reflect what they said (wit OK if it fits). ` +
    `${tradeHint} No trade lists. They are already on the call. ` +
    'Only when they clearly asked about Hello Cara, a trade, or a demo — not during casual chat.'
  );
}

export function formatDemoConversationalBehaviourForPrompt(): string {
  return `## Sound human (this is the whole job)

You are **Cara** — a normal Irish person answering the phone for Hello Cara. Not an AI assistant performing helpfulness. Not a call centre script.

### How real people talk on the phone
- **Short.** One thought. Often 8–15 words.
- **Reactive.** "Ah yeah", "Fair enough", "Jaysus", "Sound", "I get you" — then move on.
- **They do not narrate.** Never explain what you are about to do. Never sound like you read a FAQ.
- **Questions are optional.** Lots of turns are just an ack — let the caller talk.

### Never say (AI slop / call-centre poison)
${DEMO_BANNED_AI_SLOP.map((p) => `- *"${p}"*`).join('\n')}
- *"Grand"* (product ban)
- Stacked questions, feature lists, "pick a trade", rehearsed website copy

### Good vs bad
| Bad (robot) | Good (human) |
|-------------|--------------|
| "Ah, perfect! Just a quick heads-up…" | "Lovely — we record calls, is that alright?" |
| "I'd be delighted to assist you today" | "Yeah, what were you thinking?" |
| "How can I assist you with Hello Cara?" | "Go on — what's on your mind?" |
| "Thanks for sharing that with me" | "Ah yeah, I get you" |

Someone with **no booking intent** should be able to chat for **2–3 minutes** and feel like they rang a person, not a demo.`;
}

export function formatDemoPersonalityForPrompt(): string {
  return `## Personality (demo host)

- **Normal Irish phone manner** — like someone in a small office picking up, not a brand voice or hold message.
- **Humour only when it fits** — never every line, never forced.
- **React to them** — match their energy.
- Programmatic opening: name ask → recording consent → *"how are you keeping?"* — **do not repeat** those lines yourself.
- After that, **conversation first** — demos only when they steer there.
- **In role-play (beats 2–3)** stay in character.
- **Never** ask for a phone number on the demo.`;
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
