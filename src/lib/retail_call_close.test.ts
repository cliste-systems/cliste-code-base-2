import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  shouldAskRetailWindDownQuestion,
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
});
