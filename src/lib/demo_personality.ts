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

export function formatDemoFirstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? name.trim();
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function normalizeNameCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (NOT_NAMES.has(lower) || /^cara$/i.test(trimmed) || /^hello$/i.test(trimmed)) return null;
  return formatDemoFirstName(trimmed);
}

export function extractDemoCallerNameResponse(text: string): string | null {
  const introduced = extractCallerIntroducedName(text);
  if (introduced) return introduced;

  const bare = text.trim().replace(/[.!?,]+$/g, '').trim();
  if (/^[a-z][a-z'-]{1,19}$/i.test(bare)) {
    return normalizeNameCandidate(bare);
  }

  // STT echo of the greeting — "hello you're through to Brendan/Brandon"
  const throughTo = text.match(/\bthrough to\s+([a-z][a-z'-]{1,19})\b/i);
  if (throughTo?.[1]) {
    const name = normalizeNameCandidate(throughTo[1]);
    if (name) return name;
  }

  // Trailing name after filler — "uh Brendan"
  const trailing = text.match(/\b(?:uh|um|er|ah|well|so|like)[,\s]+([a-z][a-z'-]{1,19})\s*$/i);
  if (trailing?.[1]) {
    const name = normalizeNameCandidate(trailing[1]);
    if (name) return name;
  }

  return null;
}

export function extractCallerIntroducedName(text: string): string | null {
  const t = text
    .trim()
    .replace(/^(uh|um|er|ah|well|so|like)[,\s]+/i, '')
    .trim();
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

/** Fixed turn-2 reply after the caller gives their name on the demo line. */
export function buildDemoRecordingConsentReply(name: string): string {
  const firstName = formatDemoFirstName(name);
  return `Ah, perfect, ${firstName}. Just a quick heads-up, this call may be recorded and transcribed. Is that okay with you?`;
}

/** Fixed reply after the caller agrees to recording on the demo line. */
export function buildDemoAfterConsentReply(name: string): string {
  const firstName = formatDemoFirstName(name);
  return `Great, thanks ${firstName}. So, how are you keeping today?`;
}

/** @deprecated Use buildDemoRecordingConsentReply */
export function buildDemoAfterNameReply(name: string): string {
  return buildDemoRecordingConsentReply(name);
}

export function buildDemoRecordingConsentRetrySteer(): string {
  return (
    'They did not clearly answer whether recording/transcription is okay. ONE warm Irish line — ask again if that is okay with them. ' +
    'Do not rush to business questions or demos. Do not repeat the opening greeting. Do not say "grand".'
  );
}

export function buildDemoRecordingDeclineSteer(): string {
  return (
    'They declined recording/transcription. ONE warm, understanding line — no pressure. ' +
    'Say we can still chat, but the demo works best with recording on. Ask gently once more if they are okay to continue with it. ' +
    'Do not say "grand".'
  );
}

/** Opening phase — still waiting for the caller's name. */
export function buildDemoAskNameSteer(callerText: string, opts?: { audioCheck?: boolean }): string {
  if (opts?.audioCheck) {
    return (
      'They asked if you can hear them. ONE warm Irish line that you hear them fine — ' +
      'then ask who you are speaking with (one short question). ' +
      'Do not repeat the opening greeting. Do not answer other questions yet. Do not say "grand".'
    );
  }
  const snippet = callerText.trim().slice(0, 200);
  return (
    `They said: "${snippet}" but have not given their name yet. ONE warm Irish line — ` +
    'acknowledge them briefly if needed, then ask who you are speaking with. ' +
    'Do not answer their question yet. Do not repeat the full opening greeting. Do not say "grand".'
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
    `They said: "${snippet}". LISTEN → ACKNOWLEDGE → RESPOND → CONTINUE. ` +
    'ONE warm Irish line (~22 words) that reflects what they actually said — react, do not interrogate. ' +
    'Often NO question — let them lead. Do NOT ask what they want, what service they need, or what brought them to Hello Cara yet. ' +
    'Do NOT list trades, features, or role-play. Do NOT say "How can I assist you?" or corporate phrases. Do not say "grand".'
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
    `They said: "${snippet}". ONE warm line with personality — reflect what they said (a little wit OK). ` +
    `${tradeHint} No trade lists. No sample-call offers. They are already on the demo. ` +
    'Only go here when they clearly asked about Hello Cara, a trade, or a demo — not during casual chat.'
  );
}

export function formatDemoConversationalBehaviourForPrompt(): string {
  return `## Conversational demo behaviour (primary goal)

The demo line exists so callers feel they are talking to a **real Irish receptionist** — warm, relaxed, attentive, human. **Not** to prove booking, routing, or task features immediately.

### Core loop
**LISTEN → UNDERSTAND → ACKNOWLEDGE → RESPOND → CONTINUE**

Never: **LISTEN → DETECT INTENT → STANDARD RESPONSE**

### Rules
1. **Respond to what they actually said** — acknowledge their last line before moving on. Bad: *"How can I assist you today?"* after they said they had a long day. Good: *"Ah, one of those days, is it?"*
2. **Do not constantly ask questions** — real people react too (*"Ah yeah, I know what you mean"*, *"Fair enough"*, *"That's good"*). Let them continue.
3. **Short acknowledgements** (use unpredictably, not every turn): *"Yeah, absolutely"*, *"Ah yeah"*, *"Fair enough"*, *"Of course"*, *"No bother"*, *"Ah, lovely"*, *"Yeah, exactly"*.
4. **Irish through rhythm, not caricature** — *"How are you keeping?"*, *"No bother"*, *"Fair enough"*. Never: *"Top of the morning!"*, *"Begorrah!"*, *"Ah sure look altogether boss"*.
5. **Allow back-and-forth** — if they want to chat, chat. Light humour when natural (*"Well, I don't exactly get weekends off"*). Spontaneous, not scripted.
6. **Remember details** they gave (name, town) — reference naturally later; never re-ask.
7. **Subtle warmth** — not *"Absolutely fantastic!"* or *"I'd be delighted to help!"*. Prefer *"Ah yeah, nice one"*, *"That's good"*, *"I get you"*.
8. **Do not rush the business function** — if they are just chatting or testing you, stay in conversation. No feature dumps, trade lists, or *"How may I assist you?"*

### Avoid corporate phrases
- *"How may I assist you?"*, *"I understand your query"*, *"Certainly, I can assist with that"*, *"Please provide me with…"*, *"What service are you interested in?"*

### The test
Someone with **no booking intent** should be able to talk for **2–3 minutes** and feel genuinely listened to.`;
}

export function formatDemoPersonalityForPrompt(): string {
  return `## Personality (demo host)

- **Natural Irish receptionist** — warm phone manner, not a hold message or American cheer.
- **Light humour in small doses** when it fits — never forced every line.
- **React to them** — playful if they are; calm if they are serious.
- Programmatic opening flow: name ask → recording consent → *"how are you keeping today?"* — **do not repeat** those scripts.
- After that, **conversation first** — product/trade demos only when they clearly steer there.
- **In role-play (beats 2–3)** stay in character.
- **Never** ask for phone number on the demo.`;
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
