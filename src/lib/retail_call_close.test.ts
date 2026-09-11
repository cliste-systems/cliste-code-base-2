import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldCloseRetailCallWhenCallerDone } from './retail_call_close.js';

const baseFlags = {
  retailSubstantiveExchangeComplete: true,
  askedAnythingElse: false,
  awaitingAnythingElseReply: false,
  bookingLinkSendInFlight: false,
  callbackRequested: false,
  actionTicketCreated: false,
  endPhoneCallUsed: false,
  closingCall: false,
};

describe('shouldCloseRetailCallWhenCallerDone', () => {
  it('closes when caller says that is everything after a substantive exchange', () => {
    assert.equal(
      shouldCloseRetailCallWhenCallerDone(
        "Well, that's everything I wanted to know.",
        baseFlags,
      ),
      true,
    );
  });

  it('closes on imminent close phrases', () => {
    assert.equal(
      shouldCloseRetailCallWhenCallerDone("No thanks, that's everything", baseFlags),
      true,
    );
  });

  it('does not close before Cara has answered something', () => {
    assert.equal(
      shouldCloseRetailCallWhenCallerDone("That's everything", {
        ...baseFlags,
        retailSubstantiveExchangeComplete: false,
      }),
      false,
    );
  });

  it('does not close when anything-else flow is already active', () => {
    assert.equal(
      shouldCloseRetailCallWhenCallerDone('No', {
        ...baseFlags,
        askedAnythingElse: true,
      }),
      false,
    );
  });

  it('does not close when caller asks a new question', () => {
    assert.equal(
      shouldCloseRetailCallWhenCallerDone(
        "That's everything — can you repeat the number?",
        baseFlags,
      ),
      false,
    );
  });

  it('does not close mid callback capture', () => {
    assert.equal(
      shouldCloseRetailCallWhenCallerDone("That's all, thanks", {
        ...baseFlags,
        callbackRequested: true,
      }),
      false,
    );
  });
});
