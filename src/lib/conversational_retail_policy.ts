/**
 * 9508 Pure LLM Lane — policy freeze.
 *
 * After the PCM greeting, ONLY the LLM speaks live. Allowed code on conversational retail:
 * - Cached PCM greeting playback
 * - endPhoneCall disconnect
 *
 * Side effects (action tickets, dashboard updates) run **post-call** via postCallActions JSON.
 *
 * Do NOT add: caller-text regex handlers, steerReply, safeGenerateReply mid-call,
 * sayPrepared mid-call, dead-air prompts, programmatic close, or live takeCallbackMessage on 9508.
 */

const PLACEHOLDER_CALLER_NAMES = /^(caller|unknown|n\/a|none|customer|guest)$/i;

export function isPlaceholderCallerName(name: string): boolean {
  const t = name.trim();
  return !t || PLACEHOLDER_CALLER_NAMES.test(t);
}

/** staffSummary that is only an hours/directions question — answer in speech instead. */
export function staffSummaryLooksLikeSpeechOnlyQuestion(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (/\b(cake|bakery|order|complaint|manager|stock|delivery|callback|message)\b/.test(t)) {
    return false;
  }
  if (/\b(opening hours|store hours|opening times|are you open|when.*open)\b/.test(t)) {
    return true;
  }
  return (
    /\b(open|opening|hours|closed|closing|directions|location|address|where are you)\b/.test(t) &&
    t.split(' ').length <= 18
  );
}

export function formatSpeechOnlyHoursPromptBlock(): string {
  return `## Opening hours (speech only)
When callers ask if you are open, opening times, or hours for today/tomorrow/a weekday: answer in **one spoken sentence** from **Structured hours** below.`;
}
