/**
 * Demo line — under no circumstances may Cara stay silent after the caller speaks.
 */

import {
  classifyHelloCaraAboutQuestion,
  helloCaraAboutSteerInstructions,
} from './hello_cara_website_facts.js';

export const DEMO_REPLY_FAST_GUARANTEE_MS = 1200;
export const DEMO_SILENCE_WATCHDOG_MS = 2500;
export const DEMO_CALLER_REPLY_NUDGE_MS = 1500;
export const DEMO_THINKING_STALL_MS = 2000;

const NEVER_SILENT =
  'You MUST speak now — one short natural sentence. Never stay silent after the caller spoke.';

export function buildDemoNeverSilentSteer(callerText: string): string {
  const snippet = callerText.trim().slice(0, 200);
  if (!snippet) {
    return `${NEVER_SILENT} Ask who is on the line or react naturally — no call-centre tone.`;
  }

  const about = classifyHelloCaraAboutQuestion(snippet);
  if (about) {
    return `${helloCaraAboutSteerInstructions(about)} ${NEVER_SILENT}`;
  }

  return (
    `The caller said: "${snippet}". ${NEVER_SILENT} ` +
    'React like a normal person on the phone — no repeat greeting, no recording notice, no trade lists.'
  );
}

export function buildDemoSilenceWatchdogSteer(callerText: string): string {
  return (
    `${buildDemoNeverSilentSteer(callerText)} ` +
    'Your last attempt did not reach the caller — speak immediately.'
  );
}

export function buildDemoCallerReplyNudgeSteer(callerText: string): string {
  const snippet = callerText.trim().slice(0, 200);
  const t = snippet.toLowerCase();
  const audioCheck =
    /\b(can you hear me|can you hear|hear me ok|hear me okay|are you there|you there)\b/.test(t) ||
    /^(hello|hi)\s+(can you hear|are you there)\b/.test(t);
  const hearMeLine = audioCheck
    ? 'If they asked whether you can hear them, say yes warmly — then ask who you are speaking with. '
    : '';
  return (
    `The caller said: "${snippet}". Reply in **one short spoken sentence** (8–18 words). ` +
    `${NEVER_SILENT} Do not repeat your opening greeting or any AI/recording disclosure. ` +
    `${hearMeLine}` +
    (hearMeLine
      ? ''
      : 'React to what they actually said — sound human, not like a chatbot. No service intake, no trade lists.')
  );
}
