import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assistantAskedAnythingElse,
  assistantAskedServiceIntake,
  assistantClaimsLinkWasSent,
  callerAskedNewQuestion,
  callerAskedPhoneOrHumanBooking,
  callerPivotedFromSmsConsent,
  callerSaidNothingElse,
} from './speech_triggers.js';

describe('speech_triggers', () => {
  it('matches the CALL FLOW anything-else spine phrase', () => {
    assert.equal(
      assistantAskedAnythingElse('Is there anything else I can help you with?'),
      true,
    );
  });

  it('does not match unrelated lines', () => {
    assert.equal(assistantAskedAnythingElse('What service would you like?'), false);
  });

  it('does not treat bare no as nothing-else close', () => {
    assert.equal(callerSaidNothingElse('No'), false);
    assert.equal(callerSaidNothingElse("No that's not possible"), false);
    assert.equal(callerSaidNothingElse("That's all, thanks"), true);
  });

  it('detects false link-sent claims', () => {
    assert.equal(assistantClaimsLinkWasSent("That's sent now"), true);
    assert.equal(assistantClaimsLinkWasSent('That link has everything you need'), true);
    assert.equal(assistantClaimsLinkWasSent("I've texted you the link"), true);
    assert.equal(assistantClaimsLinkWasSent('Shall I text you that link?'), false);
  });

  it('detects continued Q&A vs wind-down', () => {
    assert.equal(callerAskedNewQuestion('Do you do keratin treatments?'), true);
    assert.equal(callerAskedNewQuestion("That's all, thanks"), false);
    assert.equal(callerAskedNewQuestion('No'), false);
  });

  it('detects phone-booking pivot during consent', () => {
    const pivot =
      "Um, yeah, actually, maybe. Um, is there any way you can get a team member to— can I book over the phone, actually?";
    assert.equal(callerAskedPhoneOrHumanBooking(pivot), true);
    assert.equal(callerPivotedFromSmsConsent(pivot), true);
  });

  it('detects service intake questions', () => {
    assert.equal(
      assistantAskedServiceIntake(
        'What type of appointment are you looking to book — hair, nails, lashes, or something else?',
      ),
      true,
    );
    assert.equal(
      assistantAskedServiceIntake(
        "I can text you our booking link to the number you're calling from — is that alright?",
      ),
      false,
    );
  });
});
