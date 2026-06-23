import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assistantOfferedBookingLinkConsent,
  BOOKING_SMS_CONSENT_PHRASES,
  callerDeclinedSmsConsent,
  callerGrantedSmsConsent,
} from './booking_consent.js';

/** Good booking example embedded in cara_prompt.ts (must arm auto-SMS). */
const PROMPT_GOOD_BOOKING_CONSENT =
  "Lovely — a gel manicure, grand. Easiest is to book online — I can text you our booking link to the number you're calling from — is that alright?";

describe('booking_consent', () => {
  it('matches every canonical SMS consent phrase from the prompt', () => {
    for (const phrase of BOOKING_SMS_CONSENT_PHRASES) {
      assert.equal(
        assistantOfferedBookingLinkConsent(phrase),
        true,
        `must match: ${phrase}`,
      );
    }
  });

  it('matches the Good booking consent example from cara_prompt.ts', () => {
    assert.equal(assistantOfferedBookingLinkConsent(PROMPT_GOOD_BOOKING_CONSENT), true);
  });

  it('does not match channel offers without consent ask', () => {
    assert.equal(
      assistantOfferedBookingLinkConsent(
        'Would you like to book online? I can text or email you the booking link — whichever is easier.',
      ),
      false,
    );
  });

  it('does not match service intake or post-send confirmation', () => {
    assert.equal(
      assistantOfferedBookingLinkConsent('What service would you like to book?'),
      false,
    );
    assert.equal(assistantOfferedBookingLinkConsent("That's sent now."), false);
  });

  it('does not match directions-only offers', () => {
    assert.equal(
      assistantOfferedBookingLinkConsent(
        'I can text you directions to the salon — is that alright?',
      ),
      false,
    );
  });

  it('does not treat booking please as SMS consent', () => {
    assert.equal(callerGrantedSmsConsent('Could I get lashes, please?'), false);
    assert.equal(callerGrantedSmsConsent('I want to book with Emma please'), false);
    assert.equal(callerGrantedSmsConsent('Grand'), false);
  });

  it('treats explicit yes as SMS consent', () => {
    assert.equal(callerGrantedSmsConsent('Yes'), true);
    assert.equal(callerGrantedSmsConsent('Yeah please'), true);
    assert.equal(callerGrantedSmsConsent('Go ahead'), true);
    assert.equal(callerGrantedSmsConsent("That's fine"), true);
  });

  it('detects SMS decline', () => {
    assert.equal(callerDeclinedSmsConsent("No that's not possible"), true);
    assert.equal(callerDeclinedSmsConsent('Nope'), true);
    assert.equal(callerDeclinedSmsConsent('Yes'), false);
  });

  it('does not treat hedged phone-booking pivot as SMS consent', () => {
    const pivot =
      "Um, yeah, actually, maybe. Um, is there any way you can get a team member to— can I book over the phone, actually?";
    assert.equal(callerGrantedSmsConsent(pivot), false);
  });
});
