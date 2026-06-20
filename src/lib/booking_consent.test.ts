import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assistantOfferedBookingLinkConsent,
  BOOKING_SMS_CONSENT_PHRASES,
} from './booking_consent.js';

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
});
