import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { callerSoundsLikeImminentClose } from './demo_close.js';
import {
  assistantAskedAnythingElse,
  assistantAskedServiceIntake,
  assistantClaimsLinkWasSent,
  assistantOffersRedundantSampleCall,
  assistantSoundsLikeCorporateAssist,
  assistantSoundsLikeTradeMenu,
  callerAskedNewQuestion,
  callerAskedPhoneOrHumanHandoff,
  callerAsksDemoMenu,
  callerExplicitlyRequestedHangup,
  callerPivotedFromSmsConsent,
  callerSaidNothingElse,
  callerSoundsLikeAudioCheck,
  callerSoundsLikeCallerFrustration,
  callerSoundsLikeLineEngagement,
  callerSoundsLikeSocialChitchat,
  callerSoundsLikeFollowUpRequest,
  callerSoundsLikeVagueDemoOpening,
  callerWindingDownCall,
  demoCallerReadyForClose,
} from './speech_triggers.js';

describe('speech_triggers', () => {
  it('detects demo menu questions', () => {
    assert.equal(callerAsksDemoMenu('What can we demo?'), true);
    assert.equal(callerAsksDemoMenu("I'm wondering what can we demo"), true);
    assert.equal(callerAsksDemoMenu('Demo an electrician'), false);
  });

  it('detects redundant sample-call offers on the demo line', () => {
    assert.equal(
      assistantOffersRedundantSampleCall(
        'Would you like to hear how I sound on a sample call?',
      ),
      true,
    );
    assert.equal(
      assistantOffersRedundantSampleCall('Fancy pretending you\'re ringing a garage?'),
      false,
    );
  });

  it('detects robotic trade menu lists', () => {
    assert.equal(
      assistantSoundsLikeTradeMenu(
        'Sure — you can demo a call for a trade like an electrician, shop, or shop.',
      ),
      true,
    );
    assert.equal(
      assistantSoundsLikeTradeMenu('Fancy a quick electrician example?'),
      false,
    );
  });

  it('matches the CALL FLOW anything-else spine phrase', () => {
    assert.equal(
      assistantAskedAnythingElse('Is there anything else I can help you with?'),
      true,
    );
    assert.equal(assistantAskedAnythingElse('Is that everything for you?'), true);
    assert.equal(assistantAskedAnythingElse('Are you all sorted?'), true);
  });

  it('does not match unrelated lines', () => {
    assert.equal(assistantAskedAnythingElse('What service would you like?'), false);
  });

  it('does not treat bare no or recording consent as nothing-else close', () => {
    assert.equal(callerSaidNothingElse('No'), false);
    assert.equal(callerSaidNothingElse("No that's not possible"), false);
    assert.equal(callerSaidNothingElse("That's all, thanks"), true);
    assert.equal(callerSaidNothingElse("No, I'm okay"), true);
    assert.equal(callerSaidNothingElse("That's fine"), false);
    assert.equal(callerSaidNothingElse("Yeah, that's fine"), false);
  });

  it('detects explicit hang-up requests', () => {
    assert.equal(callerExplicitlyRequestedHangup('End call'), true);
    assert.equal(callerExplicitlyRequestedHangup('Can you hang up please?'), true);
    assert.equal(callerExplicitlyRequestedHangup('What can you do?'), false);
  });

  it('treats bare no as wind-down only in anything-else context', () => {
    assert.equal(callerWindingDownCall('No'), true);
    assert.equal(callerWindingDownCall('Nope, thanks'), true);
    assert.equal(callerWindingDownCall("No that's not possible"), false);
    assert.equal(callerWindingDownCall("That's all, thanks"), true);
    assert.equal(callerWindingDownCall("No, that's everything. Thanks."), true);
    assert.equal(callerWindingDownCall("No, I'm okay"), true);
    assert.equal(callerWindingDownCall("I said I'm okay, thanks"), true);
    assert.equal(callerWindingDownCall('End call'), true);
  });

  it('does not treat recording consent as wind-down', () => {
    assert.equal(callerWindingDownCall("Yeah, that's fine"), false);
    assert.equal(callerWindingDownCall('Yeah, that is fine'), false);
    assert.equal(callerWindingDownCall('Sure, no problem'), false);
    assert.equal(callerWindingDownCall("No, that's fine, thanks"), true);
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

  it('detects phone-link pivot during consent', () => {
    const pivot =
      "Um, yeah, actually, maybe. Um, is there any way you can get a team member to— can I book over the phone, actually?";
    assert.equal(callerAskedPhoneOrHumanHandoff(pivot), true);
    assert.equal(callerPivotedFromSmsConsent(pivot), true);
  });

  it('does not treat chitchat or hours questions as SMS consent pivot', () => {
    assert.equal(callerPivotedFromSmsConsent('How are you keeping yourself?'), false);
    assert.equal(
      callerPivotedFromSmsConsent("I'm doing good. Yeah. Are you talking tomorrow?"),
      false,
    );
    assert.equal(callerPivotedFromSmsConsent('Can you hear me?'), false);
  });

  it('detects audio check lines', () => {
    assert.equal(callerSoundsLikeAudioCheck('Can you hear me?'), true);
    assert.equal(callerSoundsLikeAudioCheck('What time are you open?'), false);
  });

  it('detects bare hello/hi line checks separately from social chitchat', () => {
    assert.equal(callerSoundsLikeLineEngagement('Hello?'), true);
    assert.equal(callerSoundsLikeLineEngagement('Hi there'), true);
    assert.equal(callerSoundsLikeSocialChitchat('Hello?'), false);
    assert.equal(callerSoundsLikeSocialChitchat('Hi there'), false);
    assert.equal(callerSoundsLikeSocialChitchat('Hello, how are you keeping today?'), true);
  });

  it('detects caller frustration after being ignored', () => {
    assert.equal(callerSoundsLikeCallerFrustration('Are you just going to ignore me?'), true);
    assert.equal(callerSoundsLikeCallerFrustration('Hello?'), true);
    assert.equal(callerSoundsLikeCallerFrustration('Are you still there?'), true);
    assert.equal(callerSoundsLikeCallerFrustration('Are you open tomorrow?'), false);
  });

  it('detects service intake questions', () => {
    assert.equal(
      assistantAskedServiceIntake(
        'What type of callback are you looking to book — hair, nails, lashes, or something else?',
      ),
      true,
    );
    assert.equal(
      assistantAskedServiceIntake(
        "I can text you our link link to the number you're calling from — is that alright?",
      ),
      false,
    );
  });

  it('detects social chitchat without link intent', () => {
    assert.equal(callerSoundsLikeSocialChitchat('Hello, how are you keeping today?'), true);
    assert.equal(callerSoundsLikeSocialChitchat('You keeping?'), true);
    assert.equal(
      callerSoundsLikeSocialChitchat("I'm not too bad. Um, what's weather like with you?"),
      true,
    );
    assert.equal(
      callerSoundsLikeSocialChitchat("I'd like to book a root touch-up please"),
      false,
    );
  });

  it('detects vague demo openings with wellness plus small talk', () => {
    assert.equal(
      callerSoundsLikeVagueDemoOpening("I'm not too bad. Um, what's weather like with you?"),
      true,
    );
    assert.equal(callerSoundsLikeVagueDemoOpening("I'm good thanks"), true);
    assert.equal(
      callerSoundsLikeVagueDemoOpening("Not too bad — I run a shop and I'm curious"),
      false,
    );
  });

  it('detects corporate assist phrasing', () => {
    assert.equal(
      assistantSoundsLikeCorporateAssist("I'm here to help! What can I assist you with today?"),
      true,
    );
    assert.equal(assistantSoundsLikeCorporateAssist("I'm good thanks — yourself?"), false);
  });

  it('gates demo programmatic close on wind-down confirmation', () => {
    assert.equal(
      demoCallerReadyForClose("Yeah, that's fine", { awaitingAnythingElseReply: false }),
      false,
    );
    assert.equal(
      demoCallerReadyForClose("That's all, thanks", { awaitingAnythingElseReply: false }),
      true,
    );
    assert.equal(
      demoCallerReadyForClose('Yeah', { awaitingAnythingElseReply: true, askedAnythingElse: true }),
      true,
    );
    assert.equal(
      demoCallerReadyForClose('Thanks', { awaitingAnythingElseReply: false }),
      false,
    );
  });

  it('detects imminent interim close phrases for early STT arm', () => {
    assert.equal(callerSoundsLikeImminentClose("No thanks, that's everything"), true);
    assert.equal(
      callerSoundsLikeImminentClose("That's everything — can you repeat the number?"),
      false,
    );
  });

  it('does not close when wind-down line also asks a follow-up', () => {
    assert.equal(
      callerSoundsLikeFollowUpRequest("That's everything — can you repeat the number?"),
      true,
    );
    assert.equal(
      demoCallerReadyForClose("That's everything — can you repeat the number?", {
        awaitingAnythingElseReply: false,
      }),
      false,
    );
    assert.equal(
      demoCallerReadyForClose("That's all, thanks", { awaitingAnythingElseReply: false }),
      true,
    );
  });
});
