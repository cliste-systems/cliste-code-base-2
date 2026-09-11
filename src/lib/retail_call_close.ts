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
>;

/** Caller sounds finished — ask "anything else?" once before hanging up. */
export function shouldAskRetailWindDownQuestion(
  text: string,
  flags: RetailCloseFlags,
): boolean {
  if (flags.endPhoneCallUsed || flags.closingCall) return false;
  if (flags.bookingLinkSendInFlight) return false;
  if (!flags.retailSubstantiveExchangeComplete) return false;
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
  if (flags.callerRespondedAfterAnythingElse || callerWindingDownCall(text)) {
    return true;
  }
  return false;
}
