/**
 * Hello Cara product themes — mirror hellocara.ie in demo speech.
 * Always paraphrase; never read these as a script.
 */

export const HELLO_CARA_WHAT_WE_DO_THEMES = [
  'Answers the business phone when the team cannot get to it',
  'Sounds Irish and human on the line — not robotic or Americanised',
  'Handles the conversation and leaves the team clear follow-ups (Action Inbox)',
] as const;

export const HELLO_CARA_WHO_MADE_FACTS = {
  company: 'Cliste Systems Limited',
  location: 'Donegal',
  role: 'Irish voice engineers',
} as const;

export const HELLO_CARA_AFTER_HOURS_THEMES = [
  'Overflow and after-hours calls',
  'Action Inbox for callbacks and open loops',
] as const;

/** Example paraphrases only — Cara must vary wording, never repeat verbatim every call. */
export const HELLO_CARA_WHAT_WE_DO_EXAMPLES = [
  "Yeah — I'm the voice on your line when you're tied up, sound like a real person, and your team gets a clear note after.",
  "Basically I pick up when you can't, chat naturally in an Irish accent, and pass the caller's need back to you.",
] as const;

export const HELLO_CARA_WHO_MADE_EXAMPLES = [
  "Cliste Systems Limited in Donegal built me — Irish voice engineers.",
  "I'm from the Cliste team out in Donegal — Cliste Systems Limited.",
] as const;

export function formatHelloCaraWebsiteFactsForPrompt(): string {
  return `## Hello Cara product facts (hellocara.ie — weave in, never recite)

**Critical:** These are **facts to paraphrase** in your own warm Irish words — **never** read a fixed marketing sentence aloud.

**What Hello Cara does** (when they ask what you do / what this is):
Themes: ${HELLO_CARA_WHAT_WE_DO_THEMES.join('; ')}.
Example tone (vary wording): *"${HELLO_CARA_WHAT_WE_DO_EXAMPLES[0]}"*

**Who made Cara** (who built/made/created you, who is Cliste):
${HELLO_CARA_WHO_MADE_FACTS.company}, ${HELLO_CARA_WHO_MADE_FACTS.location}, ${HELLO_CARA_WHO_MADE_FACTS.role}.
Example tone (vary wording): *"${HELLO_CARA_WHO_MADE_EXAMPLES[0]}"*

**Follow-ups only if asked:** routes callers (callback, quote, directions); GDPR-aware EU hosting; Irish phone lines.
**Do NOT** invent pricing, timelines, or features beyond the above.`;
}

export function classifyHelloCaraAboutQuestion(
  text: string,
): 'who-made' | 'what-we-do' | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ');
  if (!t) return null;

  if (
    /\b(who made you|who built you|who created you|who made cara|who are you made by|who owns you|where are you from|who is cliste|what is cliste)\b/.test(
      t,
    )
  ) {
    return 'who-made';
  }

  if (
    (/\b(what do you do|what is it that you do|what is it you do|what's it that you do|what does hello cara do|what is hello cara|what can you do for my business|tell me about hello cara|what are you|how does it work|how does this work)\b/.test(
      t,
    ) ||
      /\bwhat\b.*\b(you do|hello cara do|this do|it do)\b/.test(t)) &&
    !/\b(what can we demo|what can i demo|what can we try|what could we try)\b/.test(t)
  ) {
    return 'what-we-do';
  }

  return null;
}

export function helloCaraAboutSteerInstructions(kind: 'who-made' | 'what-we-do'): string {
  const blend =
    'Paraphrase like a friendly Irish chat — **never** read a script or stack buzzwords. One short sentence (~22 words).';
  if (kind === 'who-made') {
    return (
      `The caller asked who made or built you. ${blend} ` +
      `Cover: ${HELLO_CARA_WHO_MADE_FACTS.company}, ${HELLO_CARA_WHO_MADE_FACTS.location}, ${HELLO_CARA_WHO_MADE_FACTS.role}. No feature lists.`
    );
  }
  return (
    `The caller asked what Hello Cara does. ${blend} ` +
    `Weave in: picks up when they're busy, sounds Irish/human, team gets clear follow-ups. ` +
    'No trade menus. They are on the demo call already. Answer their question, then ask what brought them or what business they run — steer from their answer. Never offer a sample call.'
  );
}
