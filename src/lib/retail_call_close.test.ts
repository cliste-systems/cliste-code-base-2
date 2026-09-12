import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  callerSoundsLikePostActionSatisfaction,
  callerSoundsLikeSpokenFarewell,
  shouldAskRetailWindDownQuestion,
  shouldCloseConversationalRetailAfterAction,
  shouldCloseRetailCallWhenCallerDone,
} from './retail_call_close.js';

const baseFlags = {
  retailSubstantiveExchangeComplete: true,
  askedAnythingElse: false,
  awaitingAnythingElseReply: false,
  callerRespondedAfterAnythingElse: false,
  bookingLinkSendInFlight: false,
  endPhoneCallUsed: false,
  closingCall: false,
  actionTicketCreated: false,
  awaitingRetailCallerName: false,
};

describe('retail_call_close', () => {
  it('asks wind-down before closing when caller sounds finished', () => {
    assert.equal(
      shouldAskRetailWindDownQuestion("Well, that's everything I wanted to know.", baseFlags),
      true,
    );
    assert.equal(
      shouldCloseRetailCallWhenCallerDone(
        "Well, that's everything I wanted to know.",
        baseFlags,
      ),
      false,
    );
  });

  it('closes after wind-down was asked and caller says no', () => {
    const afterWindDown = {
      ...baseFlags,
      askedAnythingElse: true,
      awaitingAnythingElseReply: true,
      callerRespondedAfterAnythingElse: true,
    };
    assert.equal(shouldCloseRetailCallWhenCallerDone('No, that is everything, thanks', afterWindDown), true);
    assert.equal(shouldAskRetailWindDownQuestion('No, that is everything, thanks', afterWindDown), false);
  });

  it('does not ask wind-down before Cara has answered something', () => {
    assert.equal(
      shouldAskRetailWindDownQuestion("That's everything", {
        ...baseFlags,
        retailSubstantiveExchangeComplete: false,
      }),
      false,
    );
  });

  it('does not close when wind-down was asked but caller has not answered yet', () => {
    assert.equal(
      shouldCloseRetailCallWhenCallerDone('Okay', {
        ...baseFlags,
        askedAnythingElse: true,
        awaitingAnythingElseReply: true,
      }),
      false,
    );
    assert.equal(shouldCloseRetailCallWhenCallerDone('No', {
      ...baseFlags,
      askedAnythingElse: true,
      awaitingAnythingElseReply: true,
    }), true);
  });

  it('does not close when caller asks a new question', () => {
    assert.equal(
      shouldCloseRetailCallWhenCallerDone(
        "That's everything — can you repeat the number?",
        { ...baseFlags, askedAnythingElse: true, callerRespondedAfterAnythingElse: true },
      ),
      false,
    );
  });

  it('closes on explicit hang-up without wind-down', () => {
    assert.equal(shouldCloseRetailCallWhenCallerDone('Please hang up now', baseFlags), true);
  });

  it('detects post-action satisfaction without requiring "that\'s all"', () => {
    assert.equal(callerSoundsLikePostActionSatisfaction("That's perfect, thank you very much."), true);
    assert.equal(callerSoundsLikePostActionSatisfaction('Can you repeat that?'), false);
  });

  it('skips wind-down when action ticket exists and caller is satisfied', () => {
    const afterAction = {
      ...baseFlags,
      actionTicketCreated: true,
    };
    assert.equal(
      shouldAskRetailWindDownQuestion("That's perfect, thank you very much.", afterAction),
      false,
    );
  });

  it('closes after wind-down when caller gives post-action thanks', () => {
    const afterWindDown = {
      ...baseFlags,
      actionTicketCreated: true,
      askedAnythingElse: true,
      awaitingAnythingElseReply: true,
    };
    assert.equal(
      shouldCloseRetailCallWhenCallerDone("That's perfect, thank you.", afterWindDown),
      true,
    );
  });

  it('does not ask wind-down while awaiting caller name', () => {
    assert.equal(
      shouldAskRetailWindDownQuestion("That's it, yeah", {
        ...baseFlags,
        awaitingRetailCallerName: true,
      }),
      false,
    );
  });

  it('detects spoken farewell for post-action close', () => {
    assert.equal(callerSoundsLikeSpokenFarewell('Bye-bye.'), true);
    assert.equal(callerSoundsLikeSpokenFarewell('Goodbye'), true);
    assert.equal(callerSoundsLikeSpokenFarewell('Can I order another cake?'), false);
  });

  it('closes conversational retail after action when caller is done', () => {
    const afterAction = {
      endPhoneCallUsed: false,
      closingCall: false,
      actionTicketCreated: true,
    };
    assert.equal(
      shouldCloseConversationalRetailAfterAction("Yeah, that's everything.", afterAction),
      true,
    );
    assert.equal(shouldCloseConversationalRetailAfterAction('Bye-bye.', afterAction), true);
    assert.equal(
      shouldCloseConversationalRetailAfterAction('Can I add another cake?', afterAction),
      false,
    );
    assert.equal(
      shouldCloseConversationalRetailAfterAction("Yeah, that's everything.", {
        ...afterAction,
        actionTicketCreated: false,
      }),
      false,
    );
  });
});
