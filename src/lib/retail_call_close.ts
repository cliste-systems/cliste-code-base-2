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
  | 'bookingLinkSendInFlight'
  | 'callbackRequested'
  | 'actionTicketCreated'
  | 'endPhoneCallUsed'
  | 'closingCall'
>;

/** Caller finished on retail line before "anything else?" — warm close without silence. */
export function shouldCloseRetailCallWhenCallerDone(
  text: string,
  flags: RetailCloseFlags,
): boolean {
  if (flags.endPhoneCallUsed || flags.closingCall) return false;
  if (flags.bookingLinkSendInFlight || flags.callbackRequested || flags.actionTicketCreated) {
    return false;
  }
  if (!flags.retailSubstantiveExchangeComplete) return false;
  if (flags.askedAnythingElse || flags.awaitingAnythingElseReply) return false;
  if (callerSoundsLikeFollowUpRequest(text)) return false;
  if (callerAskedNewQuestion(text)) return false;
  if (callerExplicitlyRequestedHangup(text)) return true;
  if (callerSoundsLikeImminentClose(text)) return true;
  if (callerSaidNothingElse(text)) return true;
  if (callerWindingDownCall(text)) return true;
  return false;
}
