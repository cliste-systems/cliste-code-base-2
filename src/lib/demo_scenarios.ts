/**
 * Hello Cara demo line — structured scenario playbooks (content only).
 * Loaded from Supabase when available; DEFAULT_DEMO_SCENARIOS is the fallback.
 */

import {
  HELLO_CARA_AFTER_HOURS_THEMES,
  HELLO_CARA_WHAT_WE_DO_EXAMPLES,
} from './hello_cara_website_facts.js';

export type DemoScenarioBeat = {
  label: string;
  guidance: string;
  suggestedLine?: string;
};

export type DemoScenario = {
  slug: string;
  label: string;
  triggerKeywords: string[];
  beats: DemoScenarioBeat[];
};

export const DEFAULT_DEMO_SCENARIOS: DemoScenario[] = [
  {
    slug: 'electrician',
    label: 'Electrician',
    triggerKeywords: ['electrician', 'electric', 'fuse', 'tripped', 'wiring', 'spark'],
    beats: [
      {
        label: 'Ack + value',
        guidance: 'Acknowledge electrician trade in one warm line — answer calls, take messages, text reminders. No prices or hours.',
        suggestedLine:
          'Lovely — for an electrician I\'d answer every call, take clear messages, and text follow-up reminders — want to try a quick example?',
      },
      {
        label: 'Invite role-play',
        guidance: 'Invite them to play the customer. Suggest a tripped fuse or need someone out today.',
        suggestedLine:
          'Right — pretend you\'re ringing about a tripped fuse and need someone out today, and I\'ll answer like their assistant.',
      },
      {
        label: 'In-role reply',
        guidance:
          'Stay in assistant role. Take a pretend message, ask what the issue is, ask if it is urgent — plausible mock details only, no real callback promises.',
        suggestedLine:
          'No bother — I can take a message for the electrician and let them know you need someone out; what\'s the issue, is it urgent?',
      },
      {
        label: 'Wrap demo beat',
        guidance: 'Step out of role-play. Offer another trade example or ask if they are sorted.',
        suggestedLine:
          'That\'s what your customers would hear — want to try another trade or are you sorted?',
      },
    ],
  },
  {
    slug: 'mechanic',
    label: 'Mechanic / garage',
    triggerKeywords: ['mechanic', 'garage', 'mot', 'nct', 'service', 'car repair', 'tyre'],
    beats: [
      {
        label: 'Ack + value',
        guidance: 'Acknowledge garage/mechanic — messages, service enquiries, reminders. No invented MOT prices.',
        suggestedLine:
          'Perfect — for a garage I\'d take service and MOT calls, capture the car details, and pass messages to the team — want to test it?',
      },
      {
        label: 'Invite role-play',
        guidance: 'Invite customer role-play — NCT prep or service enquiry this week.',
        suggestedLine:
          'Lovely — pretend you\'re asking if we do NCT prep this week, and I\'ll answer like the garage assistant.',
      },
      {
        label: 'In-role reply',
        guidance: 'In role — take car details and message, offer callback in speech only.',
        suggestedLine:
          'I can take your details and pass them to the mechanic for a callback — what car is it and when suits you?',
      },
      {
        label: 'Wrap demo beat',
        guidance: 'Step out of role-play. Offer another trade or wrap.',
        suggestedLine:
          'That\'s how it would sound on your line — try another trade or are you sorted?',
      },
    ],
  },
  {
    slug: 'retail',
    label: 'Shop / retail',
    triggerKeywords: ['shop', 'store', 'retail', 'supervalu', 'supermarket', 'grocery', 'butchers'],
    beats: [
      {
        label: 'Ack + value',
        guidance: 'Acknowledge retail — hours, directions, department questions on a real line. During role-play use pretend hours.',
        suggestedLine:
          'Sure — on a real shop line I\'d answer hours, directions, and department questions from your actual info — want a quick try?',
      },
      {
        label: 'Invite role-play',
        guidance: 'Invite customer role-play — ask if open tomorrow or where something is.',
        suggestedLine:
          'Pretend you\'re asking if the shop is open tomorrow, and I\'ll answer like the store assistant.',
      },
      {
        label: 'In-role reply',
        guidance:
          'Stay IN CHARACTER as the shop assistant. Give plausible pretend opening hours or directions — mock demo data (e.g. open nine till six tomorrow). Do NOT break character.',
        suggestedLine:
          'Yes — we\'re open tomorrow from nine till six; is there anything else you need while you\'re in?',
      },
      {
        label: 'Wrap demo beat',
        guidance: 'Step out of role-play. Offer another example or wrap.',
        suggestedLine:
          'That\'s the retail flow — another example or are you happy enough?',
      },
    ],
  },
  {
    slug: 'general',
    label: 'General Hello Cara',
    triggerKeywords: [
      'hello cara',
      'cliste',
      'plumber',
      'plumbing',
      'builder',
      'handyman',
      'what can you do',
      'what do you do',
      'what is it that you do',
      'what is it you do',
      'how does it work',
      'tell me about',
      'who are you',
      'what is this',
      'what can we demo',
      'what can i demo',
      'what can we try',
      'what could we try',
      'who made you',
      'who built you',
      'who created you',
      'who is cliste',
    ],
    beats: [
      {
        label: 'Value line',
        guidance:
          'Paraphrase hellocara.ie in warm Irish chat — busy line, natural voice, team gets the gist. Never read a script.',
        suggestedLine: HELLO_CARA_WHAT_WE_DO_EXAMPLES[0],
      },
      {
        label: 'Pick a try',
        guidance:
          'They told you what brought them — reflect it with warmth (wit OK). Steer from their answer: product info, their trade, or invite role-play only if they showed interest.',
        suggestedLine: 'Ah right — and is that for a business you run, or just having a nosey?',
      },
      {
        label: 'Mini demo',
        guidance: `Paraphrase: ${HELLO_CARA_AFTER_HOURS_THEMES.join('; ')} — or start role-play.`,
        suggestedLine:
          "When you're flat out or closed, I'd still pick up and leave it in your Action Inbox.",
      },
      {
        label: 'Wrap demo beat',
        guidance: 'Ask if they want another example or are finished exploring.',
        suggestedLine:
          'Happy to show another example — or are you sorted for now?',
      },
    ],
  },
];

export function detectDemoScenario(
  text: string,
  scenarios: DemoScenario[] = DEFAULT_DEMO_SCENARIOS,
): string | null {
  const norm = text.trim().toLowerCase();
  if (!norm) return null;

  let best: { slug: string; score: number } | null = null;
  for (const scenario of scenarios) {
    if (scenario.slug === 'general') continue;
    for (const kw of scenario.triggerKeywords) {
      if (norm.includes(kw.toLowerCase())) {
        const score = kw.length;
        if (!best || score > best.score) {
          best = { slug: scenario.slug, score };
        }
      }
    }
  }
  if (best) return best.slug;

  for (const scenario of scenarios) {
    if (scenario.slug !== 'general') continue;
    for (const kw of scenario.triggerKeywords) {
      if (norm.includes(kw.toLowerCase())) {
        return 'general';
      }
    }
  }
  return null;
}

export function getDemoScenarioBySlug(
  slug: string,
  scenarios: DemoScenario[] = DEFAULT_DEMO_SCENARIOS,
): DemoScenario | null {
  return scenarios.find((s) => s.slug === slug) ?? null;
}

export function formatDemoBeatHint(
  slug: string,
  beatIndex: number,
  scenarios: DemoScenario[] = DEFAULT_DEMO_SCENARIOS,
): string | null {
  const scenario = getDemoScenarioBySlug(slug, scenarios);
  if (!scenario) return null;
  const beat = scenario.beats[Math.max(0, Math.min(beatIndex, scenario.beats.length - 1))];
  if (!beat) return null;
  const line = beat.suggestedLine
    ? ` Example tone (paraphrase, do not read verbatim): "${beat.suggestedLine}"`
    : '';
  return `[Demo playbook — ${scenario.label}, beat ${beatIndex + 1}/4: ${beat.label}] ${beat.guidance}.${line}`;
}

export function formatDemoScenariosForPrompt(
  scenarios: DemoScenario[] = DEFAULT_DEMO_SCENARIOS,
): string {
  const blocks = scenarios.map((scenario) => {
    const beatLines = scenario.beats
      .map(
        (b, i) =>
          `  ${i + 1}. **${b.label}** — ${b.guidance}${b.suggestedLine ? ` Example tone (paraphrase): *"${b.suggestedLine}"*` : ''}`,
      )
      .join('\n');
    return `### ${scenario.label} (\`${scenario.slug}\`)
Triggers: ${scenario.triggerKeywords.slice(0, 6).join(', ')}${scenario.triggerKeywords.length > 6 ? ', …' : ''}
${beatLines}`;
  });
  return blocks.join('\n\n');
}

export type DemoScenarioRow = {
  slug: string;
  label: string;
  trigger_keywords: string[];
  beats: DemoScenarioBeat[];
  is_active: boolean;
  sort_order: number;
};

export function demoScenariosFromRows(rows: DemoScenarioRow[]): DemoScenario[] {
  return rows
    .filter((r) => r.is_active)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r) => ({
      slug: r.slug,
      label: r.label,
      triggerKeywords: r.trigger_keywords,
      beats: r.beats,
    }));
}
