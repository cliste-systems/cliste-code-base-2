import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDemoAfterConsentReply,
  buildDemoAskNameAgainReply,
  buildDemoConversationalReplySteer,
  buildDemoFollowMotivationSteer,
  buildDemoNameBanterSteer,
  buildDemoAskNameSteer,
  buildDemoPreNameSteer,
  buildDemoRecordingConsentReply,
  buildDemoWellbeingAckReply,
  callerSoundsLikeHelloCaraMotivation,
  extractCallerIntroducedName,
  extractDemoCallerNameResponse,
  formatDemoConversationalBehaviourForPrompt,
  formatDemoFirstName,
  isPlausibleDemoFirstName,
  looksLikeJokeName,
} from './demo_personality.js';
import { buildDemoCallerReplyNudgeSteer } from './demo_reply_guarantee.js';
import {
  callerSoundsLikeAffirmativeConsent,
  callerSoundsLikeRecordingDecline,
} from './speech_triggers.js';

const SAMPLE_NAMES = [
  'Brendan',
  'John',
  'Mary',
  'Sarah',
  'Patrick',
  'Niamh',
  'Siobhan',
  "O'Brien",
  'Jean-Pierre',
  'Muhammad',
  'Li',
  'Aoife',
  'Cillian',
  'Roisin',
  'Declan',
  'Fatima',
  'Yuki',
  'Priya',
  'Seamus',
  'Orla',
];

describe('demo_personality', () => {
  it('extracts volunteered first names', () => {
    assert.equal(extractCallerIntroducedName("I'm Brendan"), 'Brendan');
    assert.equal(extractCallerIntroducedName('My name is Sarah'), 'Sarah');
    assert.equal(extractCallerIntroducedName('This is Mickey'), 'Mickey');
  });

  it('extracts any plausible first name from common intro phrases', () => {
    for (const name of SAMPLE_NAMES) {
      const expected = formatDemoFirstName(name);
      assert.equal(extractDemoCallerNameResponse(`I'm ${name}`), expected, `I'm ${name}`);
      assert.equal(
        extractDemoCallerNameResponse(`Hello, you're speaking to ${name}.`),
        expected,
        `speaking to ${name}`,
      );
      assert.equal(
        extractDemoCallerNameResponse(`You're talking to ${name}`),
        expected,
        `talking to ${name}`,
      );
      assert.equal(
        extractDemoCallerNameResponse(`Hey, you're speaking with ${name}.`),
        expected,
        `speaking with ${name}`,
      );
      assert.equal(
        extractDemoCallerNameResponse(`My name is ${name}`),
        expected,
        `my name is ${name}`,
      );
      assert.equal(extractDemoCallerNameResponse(`${expected} here`), expected, `${expected} here`);
    }
  });

  it('extracts bare single-word name replies', () => {
    assert.equal(extractDemoCallerNameResponse('John'), 'John');
    assert.equal(extractDemoCallerNameResponse('John.'), 'John');
  });

  it('does not treat how-are-you replies as names', () => {
    assert.equal(extractDemoCallerNameResponse("I'm keeping good, yeah, and you?"), null);
    assert.equal(extractCallerIntroducedName("I'm good thanks"), null);
    assert.equal(extractDemoCallerNameResponse('Hello there'), null);
    assert.equal(extractDemoCallerNameResponse('Yeah'), null);
  });

  it('validates plausible first names generically', () => {
    assert.equal(isPlausibleDemoFirstName('Brendan'), true);
    assert.equal(isPlausibleDemoFirstName('Li'), true);
    assert.equal(isPlausibleDemoFirstName('keeping'), false);
    assert.equal(isPlausibleDemoFirstName('Cara'), false);
    assert.equal(isPlausibleDemoFirstName('a'), false);
  });

  it('ignores non-name im phrases', () => {
    assert.equal(extractCallerIntroducedName("I'm good thanks"), null);
    assert.equal(extractCallerIntroducedName("I'm just wondering"), null);
  });

  it('detects joke names for stronger banter', () => {
    assert.equal(looksLikeJokeName('Mickey Mouse'), true);
    assert.equal(looksLikeJokeName('Brendan'), false);
  });

  it('steer includes playful are-you-sure prompt for joke names only', () => {
    assert.doesNotMatch(buildDemoNameBanterSteer('Brendan'), /Are you sure/i);
    assert.match(buildDemoNameBanterSteer('Mickey Mouse'), /nearly believe/i);
  });

  it('recording consent reply asks if recording is alright', () => {
    const out = buildDemoRecordingConsentReply('John');
    assert.match(out, /John/);
    assert.match(out, /record/i);
    assert.match(out, /alright|okay/i);
    assert.doesNotMatch(out, /heads-up/i);
    assert.doesNotMatch(out, /perfect/i);
  });

  it('after-consent reply opens with how are you keeping', () => {
    const out = buildDemoAfterConsentReply('John');
    assert.match(out, /how are you keeping/i);
    assert.doesNotMatch(out, /Great, thanks/i);
    assert.doesNotMatch(out, /assist/i);
  });

  it('wellbeing ack is short with no follow-up question', () => {
    const out = buildDemoWellbeingAckReply('mary');
    assert.match(out, /not too bad|thanks/i);
    assert.doesNotMatch(out, /\?/);
    assert.doesNotMatch(out, /business|mind today|assist/i);
  });

  it('programmatic name re-ask is fixed copy', () => {
    assert.match(buildDemoAskNameAgainReply(), /who'?s this/i);
  });

  it('ask-name steer keeps caller on name before other topics', () => {
    assert.match(
      buildDemoAskNameSteer('What are you able to help with?'),
      /Do not answer their question yet/i,
    );
    assert.match(buildDemoAskNameSteer('', { audioCheck: true }), /hear them/i);
    assert.match(buildDemoPreNameSteer(), /who is on the line/i);
  });

  it('caller reply nudge steers hear-me to ask who is on the line', () => {
    assert.match(buildDemoCallerReplyNudgeSteer('Can you hear me?'), /who you are speaking with|who is on the line/i);
  });

  it('conversational steer avoids rushing to business', () => {
    assert.match(
      buildDemoConversationalReplySteer("Yeah, I've had a long day actually."),
      /No trade lists|no product pitch/i,
    );
  });

  it('embeds conversational demo behaviour guidance', () => {
    assert.match(formatDemoConversationalBehaviourForPrompt(), /Sound human/i);
    assert.match(formatDemoConversationalBehaviourForPrompt(), /how can I assist/i);
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
