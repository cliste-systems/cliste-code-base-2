/** Regex detectors for spoken assistant text — drive auto-SMS, close flow, hangup. */

export { assistantAskedAnythingElse, assistantAskedWindDown } from './natural_phrasing.js';

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
  // "that's fine" is recording consent on the demo line — not "nothing else".
  return /\b(that'?s all|thats all|that'?s everything|thats everything|nothing else|all good|all grand|i'?m good|im good|i'?m okay|im okay|i am okay|that'?s it|thats it|no more|we'?re good|i'?m all set|im all set)\b/.test(
    t,
  );
}

/** Caller explicitly asked to end the call — not a service question. */
export function callerExplicitlyRequestedHangup(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  return /\b(end (the )?call|hang up|hangup|disconnect|put the phone down|you can hang up)\b/.test(t);
}

/** Caller asking what demos exist — steer away from trade menus. */
export function callerAsksDemoMenu(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ');
  if (!t) return false;
  return (
    /\b(what can (we|i) demo|what could we try|what are (the )?options|what can you show|what would we demo|what can we try)\b/.test(
      t,
    ) || /\bwhat can we demo\b/.test(t)
  );
}

/** Assistant read a phone-menu style list of trades/options. */
export function assistantSoundsLikeTradeMenu(text: string): boolean {
  const t = text.replace(/^Assistant:\s*/i, '').trim();
  if (!t) return false;
  if (/\b(electrician|salon|mechanic|shop|garage|beauty|retail)\b.*,\s.*\b(or|and)\b/i.test(t)) {
    return true;
  }
  if (/\b(like|such as|for example)\b/i.test(t) && (t.match(/,/g) ?? []).length >= 2) {
    return true;
  }
  return /\bpick one\b/i.test(t) && /\b(or|and)\b/i.test(t);
}

/** Caller winding down after "anything else?" — bare "no" is clear in that context. */
export function callerWindingDownCall(text: string): boolean {
  if (callerSaidNothingElse(text)) return true;
  const t = text
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (/^(no|nope|nah)(\s+(thanks|thank you))?$/i.test(t)) return true;
  if (/^no[, ]+(i'?m okay|im okay|that'?s fine|thats fine|i'?m good|im good)(\s+(thanks|thank you))?$/i.test(t)) {
    return true;
  }
  if (callerExplicitlyRequestedHangup(text)) return true;
  if (
    /\b(no you'?re grand|you'?re grand|i'?m sorted|im sorted|happy enough|sorted for now)\b/.test(t)
  ) {
    return true;
  }
  return /\b(thanks|thank you|cheers)\b/.test(t) && callerSaidNothingElse(text);
}

/** Follow-up request during wind-down — keep the call open even if they also said "that's all". */
export function callerSoundsLikeFollowUpRequest(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (/\?\s*$/.test(raw)) return true;

  const t = raw
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;

  return /\b(repeat|say that again|what was|what s the|what was the|can you|could you|one more|actually|wait|hang on|before you go)\b/.test(
    t,
  );
}

/** Demo programmatic close — after wind-down check or a clear finish signal. */
export function demoCallerReadyForClose(
  text: string,
  flags: { askedAnythingElse?: boolean; awaitingAnythingElseReply?: boolean },
): boolean {
  if (callerExplicitlyRequestedHangup(text)) return true;
  if (callerSoundsLikeFollowUpRequest(text)) return false;
  if (callerSaidNothingElse(text)) return true;

  const t = text
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (/\b(i'?m sorted|im sorted|that'?s everything|thats everything)\b/.test(t)) return true;
  if (/\b(bye|goodbye)\b/.test(t) && t.split(' ').length <= 8) return true;

  if (flags.awaitingAnythingElseReply || flags.askedAnythingElse) {
    if (callerSoundsLikeAffirmativeConsent(text)) return true;
    if (callerWindingDownCall(text)) return true;
  }

  return false;
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

/** Caller checking the line — not a service question. */
export function callerSoundsLikeAudioCheck(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[!?.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  return (
    /\b(can you hear me|can you hear|hear me ok|hear me okay|are you there|you there)\b/.test(t) ||
    /^(hello|hi)\s+(can you hear|are you there)\b/.test(t)
  );
}

/** Caller agreed to recording/transcription notice on the demo line. */
export function callerSoundsLikeAffirmativeConsent(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[!?.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (callerSoundsLikeRecordingDecline(text)) return false;
  if (/^(yes|yeah|yep|yup|sure|ok|okay|fine|absolutely|perfect|lovely|sound|course)\b/.test(t)) {
    return true;
  }
  return /\b(that'?s fine|that'?s okay|no problem|go ahead|of course|sounds good|happy with that|fine by me|i'?m fine with that|no bother)\b/.test(
    t,
  );
}

/** Caller declined recording/transcription on the demo line. */
export function callerSoundsLikeRecordingDecline(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[!?.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (/\b(no problem|no bother|that'?s fine|that'?s okay|go ahead)\b/.test(t)) return false;
  return (
    /^(no|nope|nah)\b/.test(t) ||
    /\b(rather not|don'?t want|not okay|not ok|prefer not|i'?d rather not)\b/.test(t)
  );
}

/** Caller changed topic or hedged during SMS consent — not a clear yes/no. */
export function callerPivotedFromSmsConsent(
  text: string,
  context?: { awaitingSmsConsent?: boolean },
): boolean {
  if (!text.trim() || callerSaidNothingElse(text)) return false;
  if (callerSoundsLikeSocialChitchat(text)) return false;
  if (callerSoundsLikeAudioCheck(text)) return false;
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
  if (context?.awaitingSmsConsent && callerAskedNewQuestion(text) && t.length > 28) {
    return true;
  }
  return false;
}

/** Assistant asked what service / appointment type before offering the link. */
export function assistantAskedServiceIntake(text: string): boolean {
  const t = text.trim();
  if (!t || !/\?/.test(t)) return false;
  return (
    /\bwhat (were you|type of|kind of|service)\b/i.test(t) ||
    /\b(hair, nails, lashes|nails, lashes|something else)\b/i.test(t) ||
    /\blooking to book\b/i.test(t)
  );
}

/** Assistant turn ends with a question — caller should get a chance to answer. */
export function assistantAwaitingCallerReply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (assistantAskedServiceIntake(t)) return true;
  if (
    /\b(is that alright|is that okay|shall i text|anything else|is that everything|are you all sorted)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return /\?\s*$/.test(t) || (/\?/.test(t) && t.length < 220);
}

/** Bare hello/hi/hey — line check, not small talk. */
export function callerSoundsLikeLineEngagement(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[!?.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (callerSoundsLikeAudioCheck(text)) return false;
  if (/\b(book|booking|appointment|how are you|keeping)\b/.test(t)) return false;
  return (
    /^(hello|hi|hey|hiya|howya|how ya|anyone there|you there|still there)\b/.test(t) ||
    /^(hello|hi|hey)\s*(there|cara)?\s*$/.test(t)
  );
}

const DEMO_CHITCHAT_BUSINESS_HINT =
  /\b(business|hello cara|curious|salon|shop|garage|electrician|website|pricing|because|looking for|book|appointment|demo an|try a)\b/;

/** Small talk / greeting — no thinking filler needed before the reply. */
export function callerSoundsLikeSocialChitchat(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[!?.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (/\b(book|booking|appointment|schedule|cancel|reschedule)\b/.test(t)) return false;
  if (callerSoundsLikeLineEngagement(text)) return false;
  if (
    /\b(weather|what'?s it like (there|with you|out)|how'?s the weather|soft day|lovely day|raining|showers?)\b/.test(
      t,
    )
  ) {
    return true;
  }
  return (
    /^(good morning|good afternoon|good evening|keeping|you keeping|ya keeping)\b/.test(
      t,
    ) ||
    /\b(how are you keeping|how are you doing|how are you today|how'?s it going|how'?s your day|how are ye|howya|how ya|you keeping|ya keeping|are you keeping|keeping well|you alright|you ok)\b/.test(
      t,
    ) ||
    /\bkeeping\s*(today|well|there)?\s*$/.test(t)
  );
}

/** How-are-you / wellbeing small talk — not a consent answer or business question. */
export function callerSoundsLikeWellbeingReply(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[!?.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (/\b(book|booking|appointment|schedule|cancel|reschedule|electrician|salon|demo an|hello cara)\b/.test(t)) {
    return false;
  }
  return (
    /\b(not too bad|not doing too bad|doing well|doing good|doing very good|i'?m good|very well|not bad|keeping well|keeping good|i'?m keeping|i'?m fine|i'?m alright)\b/.test(
      t,
    ) ||
    /\b(how are you keeping|how are you doing|how are you today|how'?s it going|how'?s your day)\b/.test(
      t,
    )
  );
}

/** Short hello / how-are-you reply at the start of a demo call — not a product question yet. */
export function callerSoundsLikeVagueDemoOpening(text: string): boolean {
  if (callerAsksDemoMenu(text)) return false;
  if (callerSoundsLikeSocialChitchat(text)) return true;
  if (callerSoundsLikeWellbeingReply(text)) return true;
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (/\b(what do you do|what is it that you do|what is it you do|who made|who built|electrician|salon|demo an|try a)\b/.test(t)) {
    return false;
  }
  if (
    /^(hello|hi|hiya|hey|yeah|yep|good thanks|thanks|not too bad|i'?m good|doing well|very well|not bad)[.!?]?$/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(not too bad|doing well|i'?m good|very well|not bad|keeping well)\b/.test(t) &&
    !DEMO_CHITCHAT_BUSINESS_HINT.test(t)
  ) {
    return true;
  }
  return t.length <= 24 && /^(hello|hi|hiya|hey)\b/.test(t);
}

/** Offers a "sample call" while the caller is already on the Hello Cara demo line. */
export function assistantOffersRedundantSampleCall(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return (
    /\b(sample call|hear how (?:i|you) sound|hear me on a (?:call|sample)|how i sound on a|how you sound on a|try a sample)\b/.test(
      t,
    ) || /\bwould you like to hear how\b/.test(t)
  );
}

/** Robotic call-centre phrasing — not how a friendly Irish receptionist talks. */
export function assistantSoundsLikeCorporateAssist(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return (
    /\bi'?m here to help\b/.test(t) ||
    /\bready to help out\b/.test(t) ||
    /\bjust here, ready to help\b/.test(t) ||
    /\bthanks for asking\b/.test(t) ||
    /\banything in particular on your mind\b/.test(t) ||
    /\bwhat can i assist\b/.test(t) ||
    /\bhow can i assist you\b/.test(t) ||
    /\bwhat can i help you with today\b/.test(t) ||
    /\bsomething specific you need help with\b/.test(t) ||
    /\bi'?ll be here tomorrow\b/.test(t)
  );
}

/** Caller thinks they were ignored — respond immediately, never stay silent. */
export function callerSoundsLikeCallerFrustration(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s'?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  return (
    /\b(ignore me|ignoring me|just going to ignore|why are you ignoring|not listening|didn'?t answer|never answered)\b/.test(
      t,
    ) ||
    /\b(are you (still )?there|you there|still there|anyone there)\b/.test(t) ||
    /^hello\??$/.test(t)
  );
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
