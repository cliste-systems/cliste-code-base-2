import { callerSoundsLikeImminentClose } from './demo_close.js';
import type { CaraSessionFlags } from './cara_tools.js';
import {
  callerAskedNewQuestion,
  callerExplicitlyRequestedHangup,
  callerSaidNothingElse,
  callerSoundsLikeFollowUpRequest,
  callerWindingDownCall,
} from './speech_triggers.js';

export type RetailCloseFlags = Pick<
  CaraSessionFlags,
  | 'retailSubstantiveExchangeComplete'
  | 'askedAnythingElse'
  | 'awaitingAnythingElseReply'
  | 'callerRespondedAfterAnythingElse'
  | 'bookingLinkSendInFlight'
  | 'endPhoneCallUsed'
  | 'closingCall'
  | 'actionTicketCreated'
  | 'awaitingRetailCallerName'
>;

/** Caller satisfied after a logged callback/order — skip redundant wind-down. */
export function callerSoundsLikePostActionSatisfaction(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (callerAskedNewQuestion(text)) return false;
  if (callerSoundsLikeFollowUpRequest(text)) return false;
  if (/\b(that'?s perfect|thats perfect|perfect thank|lovely thank|great thank|brilliant thank|no that'?s grand|no thats grand)\b/.test(t)) {
    return true;
  }
  if (/\b(thanks|thank you|cheers)\b/.test(t) && t.split(' ').length <= 8) {
    return true;
  }
  return false;
}

/** Caller sounds finished — ask "anything else?" once before hanging up. */
export function shouldAskRetailWindDownQuestion(
  text: string,
  flags: RetailCloseFlags,
): boolean {
  if (flags.endPhoneCallUsed || flags.closingCall) return false;
  if (flags.bookingLinkSendInFlight) return false;
  if (flags.awaitingRetailCallerName) return false;
  if (!flags.retailSubstantiveExchangeComplete) return false;
  if (flags.actionTicketCreated && callerSoundsLikePostActionSatisfaction(text)) return false;
  if (flags.askedAnythingElse || flags.awaitingAnythingElseReply) return false;
  if (callerSoundsLikeFollowUpRequest(text)) return false;
  if (callerAskedNewQuestion(text)) return false;
  if (callerExplicitlyRequestedHangup(text)) return false;
  if (callerSoundsLikeImminentClose(text)) return true;
  if (callerSaidNothingElse(text)) return true;
  if (callerWindingDownCall(text)) return true;
  return false;
}

/** After wind-down question answered — programmatic warm close + disconnect. */
export function shouldCloseRetailCallWhenCallerDone(
  text: string,
  flags: RetailCloseFlags,
): boolean {
  if (flags.endPhoneCallUsed || flags.closingCall) return false;
  if (flags.bookingLinkSendInFlight) return false;
  if (!flags.retailSubstantiveExchangeComplete) return false;
  if (callerSoundsLikeFollowUpRequest(text)) return false;
  if (callerAskedNewQuestion(text)) return false;
  if (callerExplicitlyRequestedHangup(text)) return true;
  if (!flags.askedAnythingElse) return false;
  if (
    flags.callerRespondedAfterAnythingElse ||
    callerWindingDownCall(text) ||
    (flags.actionTicketCreated && callerSoundsLikePostActionSatisfaction(text))
  ) {
    return true;
  }
  return false;
}

/** Spoken farewell — bye, bye-bye, goodbye (not a service question). */
export function callerSoundsLikeSpokenFarewell(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (callerAskedNewQuestion(text)) return false;
  if (callerSoundsLikeFollowUpRequest(text)) return false;
  if (t.split(' ').length > 6) return false;
  return /\b(bye|goodbye|good bye|see ya|cheers)\b/.test(t);
}

export type ConversationalRetailAfterActionFlags = Pick<
  CaraSessionFlags,
  'endPhoneCallUsed' | 'closingCall' | 'actionTicketCreated'
>;

/** 9508 — order/callback logged and caller sounds finished; trigger warm close + disconnect. */
export function shouldCloseConversationalRetailAfterAction(
  text: string,
  flags: ConversationalRetailAfterActionFlags,
): boolean {
  if (flags.endPhoneCallUsed || flags.closingCall) return false;
  if (!flags.actionTicketCreated) return false;
  if (callerSoundsLikeFollowUpRequest(text)) return false;
  if (callerAskedNewQuestion(text)) return false;
  return (
    callerSaidNothingElse(text) ||
    callerWindingDownCall(text) ||
    callerSoundsLikeSpokenFarewell(text) ||
    callerExplicitlyRequestedHangup(text)
  );
}
