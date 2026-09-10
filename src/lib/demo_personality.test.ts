import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDemoAfterConsentReply,
  buildDemoConversationalReplySteer,
  buildDemoFollowMotivationSteer,
  buildDemoNameBanterSteer,
  buildDemoPreNameSteer,
  buildDemoRecordingConsentReply,
  callerSoundsLikeHelloCaraMotivation,
  extractCallerIntroducedName,
  extractDemoCallerNameResponse,
  formatDemoConversationalBehaviourForPrompt,
  looksLikeJokeName,
} from './demo_personality.js';
import { buildDemoCallerReplyNudgeSteer } from './demo_reply_guarantee.js';
import {
  callerSoundsLikeAffirmativeConsent,
  callerSoundsLikeRecordingDecline,
} from './speech_triggers.js';

describe('demo_personality', () => {
  it('extracts volunteered first names', () => {
    assert.equal(extractCallerIntroducedName("I'm Brendan"), 'Brendan');
    assert.equal(extractCallerIntroducedName('My name is Sarah'), 'Sarah');
    assert.equal(extractCallerIntroducedName('This is Mickey'), 'Mickey');
  });

  it('extracts bare single-word name replies', () => {
    assert.equal(extractDemoCallerNameResponse('John'), 'John');
    assert.equal(extractDemoCallerNameResponse('John.'), 'John');
  });

  it('ignores non-name im phrases', () => {
    assert.equal(extractCallerIntroducedName("I'm good thanks"), null);
    assert.equal(extractCallerIntroducedName("I'm just wondering"), null);
  });

  it('detects joke names for stronger banter', () => {
    assert.equal(looksLikeJokeName('Mickey Mouse'), true);
    assert.equal(looksLikeJokeName('Brendan'), false);
  });

  it('steer includes playful are-you-sure prompt', () => {
    assert.match(buildDemoNameBanterSteer('Brendan'), /Are you sure/i);
    assert.match(buildDemoNameBanterSteer('Mickey Mouse'), /nearly believe/i);
  });

  it('recording consent reply asks if recording is okay', () => {
    assert.equal(
      buildDemoRecordingConsentReply('John'),
      'Ah, perfect, John. Just a quick heads-up, this call may be recorded and transcribed. Is that okay with you?',
    );
  });

  it('after-consent reply opens with how are you keeping', () => {
    assert.equal(
      buildDemoAfterConsentReply('John'),
      'Great, thanks John. So, how are you keeping today?',
    );
  });

  it('pre-name steer asks who they are without repeating opening', () => {
    assert.match(buildDemoPreNameSteer(), /who you are speaking with/i);
    assert.match(buildDemoPreNameSteer(), /Do not repeat the opening greeting/i);
    assert.match(buildDemoPreNameSteer({ audioCheck: true }), /hear them fine/i);
  });

  it('caller reply nudge steers hear-me to ask who is on the line', () => {
    assert.match(buildDemoCallerReplyNudgeSteer('Can you hear me?'), /who you are speaking with/i);
  });

  it('conversational steer avoids rushing to business', () => {
    assert.match(
      buildDemoConversationalReplySteer("Yeah, I've had a long day actually."),
      /Do NOT ask what they want/i,
    );
  });

  it('embeds conversational demo behaviour guidance', () => {
    assert.match(formatDemoConversationalBehaviourForPrompt(), /LISTEN → UNDERSTAND → ACKNOWLEDGE/i);
    assert.match(formatDemoConversationalBehaviourForPrompt(), /How may I assist you/i);
  });

  it('detects motivation answers after chitchat', () => {
    assert.equal(callerSoundsLikeHelloCaraMotivation("I'm just curious about it"), true);
    assert.equal(callerSoundsLikeHelloCaraMotivation("I'm good thanks"), false);
    assert.equal(
      callerSoundsLikeHelloCaraMotivation(
        "I'm not doing too bad now. How are you keeping yourself?",
      ),
      false,
    );
  });

  it('follow motivation steer reflects caller and steers naturally', () => {
    assert.match(
      buildDemoFollowMotivationSteer('I run a salon in Letterkenny', 'salon'),
      /salon/i,
    );
  });

  it('detects recording consent answers', () => {
    assert.equal(callerSoundsLikeAffirmativeConsent('Yeah, that is fine'), true);
    assert.equal(callerSoundsLikeRecordingDecline('No, I would rather not'), true);
    assert.equal(callerSoundsLikeAffirmativeConsent('No, I would rather not'), false);
  });
});
