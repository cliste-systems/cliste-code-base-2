/** Regex detectors for spoken assistant text — drive auto-SMS, close flow, hangup. */

export function assistantAskedAnythingElse(text: string): boolean {
  return /\banything else\b/i.test(text);
}

/** Assistant implied SMS/link was delivered — must match linkSent flag in code. */
export function assistantClaimsLinkWasSent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    /\b(that'?s sent|sent now|i'?ve texted|texted you|just texted)\b/i.test(t) ||
    /\b(link has everything|link has all the times|pick what suits you on that link)\b/i.test(t)
  );
}

/** Caller finished — not the same as declining SMS ("no" alone is ambiguous). */
export function callerSaidNothingElse(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  return /\b(that'?s all|thats all|nothing else|all good|all grand|i'?m good|im good|that'?s it|thats it|no more|we'?re good|i'?m all set|im all set)\b/.test(
    t,
  );
}

/** Caller wants human/phone booking instead of the SMS link. */
export function callerAskedPhoneOrHumanBooking(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ');
  if (!t) return false;
  return (
    /\b(book over the (phone|call)|on the phone|over the phone|speak to (someone|a person|the team|a team member|human)|team member|real person|get someone|talk to someone|someone (to )?book)\b/.test(
      t,
    ) || /\b(is there any way you can get|can i (speak|talk)|could i (speak|talk))\b/.test(t)
  );
}

/** Caller changed topic or hedged during SMS consent — not a clear yes/no. */
export function callerPivotedFromSmsConsent(text: string): boolean {
  if (!text.trim() || callerSaidNothingElse(text)) return false;
  if (callerAskedPhoneOrHumanBooking(text)) return true;
  const t = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (/\b(actually|wait|hang on)\b/.test(t) && /\b(no|not|phone|team|member|someone|maybe)\b/.test(t)) {
    return true;
  }
  if (/\b(maybe|not sure|perhaps|i don'?t know)\b/.test(t) && callerAskedNewQuestion(text)) {
    return true;
  }
  if (callerAskedNewQuestion(text) && t.length > 28) {
    return true;
  }
  return false;
}

/** Caller continued the conversation with a new question (not wind-down). */
export function callerAskedNewQuestion(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!t || callerSaidNothingElse(text)) return false;
  if (/\?\s*$/.test(text.trim())) return true;
  return /\b(can i|could i|do you|does|what|how|when|where|which|is it|are you|would you|tell me|wondering|interested in|looking for|book|booking|appointment|keratin|colour|color|cut|lash|wax|same day)\b/.test(
    t,
  );
}
