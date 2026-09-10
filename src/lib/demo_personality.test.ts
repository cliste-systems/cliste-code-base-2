import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDemoChitchatSteer,
  buildDemoFollowMotivationSteer,
  buildDemoNameBanterSteer,
  callerSoundsLikeHelloCaraMotivation,
  extractCallerIntroducedName,
  looksLikeJokeName,
} from './demo_personality.js';

describe('demo_personality', () => {
  it('extracts volunteered first names', () => {
    assert.equal(extractCallerIntroducedName("I'm Brendan"), 'Brendan');
    assert.equal(extractCallerIntroducedName('My name is Sarah'), 'Sarah');
    assert.equal(extractCallerIntroducedName('This is Mickey'), 'Mickey');
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

  it('chitchat steer asks what brought them without role-play pitch', () => {
    assert.match(buildDemoChitchatSteer(), /what brought them to Hello Cara/i);
    assert.match(buildDemoChitchatSteer(), /Do NOT pitch role-play/i);
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
});
