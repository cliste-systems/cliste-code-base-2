import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assistantPrematureTeamHandoff,
  assistantSpokeTeamHandoff,
  assistantUsesBannedAiSlop,
  buildPostConfirmSpellingSteer,
  callerGaveFirstName,
  callerSpelledNameLetterByLetter,
  isPhoneticallyAmbiguousFirstName,
  lastAssistantAskedCallerFirstName,
  parseLetterSpelledName,
} from './cake_name_intake.js';

describe('cake_name_intake', () => {
  it('detects letter-by-letter spelling', () => {
    assert.equal(callerSpelledNameLetterByLetter('B-R-E-N-D-A-N'), true);
    assert.equal(callerSpelledNameLetterByLetter('B R E N D A N'), true);
    assert.equal(callerSpelledNameLetterByLetter('Brendan'), false);
  });

  it('parses hyphenated spellings', () => {
    assert.equal(parseLetterSpelledName('B-R-E-N-D-A-N'), 'Brendan');
  });

  it('flags ambiguous first names', () => {
    assert.equal(isPhoneticallyAmbiguousFirstName('Brendan'), true);
    assert.equal(isPhoneticallyAmbiguousFirstName('Mary'), false);
  });

  it('extracts spoken first names', () => {
    assert.equal(callerGaveFirstName('Brendan.'), 'Brendan');
    assert.equal(callerGaveFirstName("It's Sean"), 'Sean');
    assert.equal(callerGaveFirstName('B-R-E-N-D-A-N'), null);
  });

  it('detects caller first-name intake across departments', () => {
    assert.equal(
      lastAssistantAskedCallerFirstName("What's the first name for the order?"),
      true,
    );
    assert.equal(
      lastAssistantAskedCallerFirstName('And your first name for collection?'),
      true,
    );
    assert.equal(
      lastAssistantAskedCallerFirstName('What name would you like on the cake?'),
      true,
    );
    assert.equal(
      lastAssistantAskedCallerFirstName('Perfect — ten sirloin steaks for collection tomorrow.'),
      false,
    );
  });

  it('detects premature team handoff across departments', () => {
    assert.equal(
      assistantPrematureTeamHandoff(
        "Right so — I'll pass that straight to the bakery for you.",
      ),
      true,
    );
    assert.equal(
      assistantPrematureTeamHandoff("No bother — I'll pass that to the team."),
      true,
    );
    assert.equal(
      assistantPrematureTeamHandoff("Grand — I'll pass that to the butcher for you."),
      true,
    );
    assert.equal(
      assistantPrematureTeamHandoff(
        'So that is a cake for nine with Happy Birthday Sean — is that all correct?',
      ),
      false,
    );
  });

  it('detects team handoff phrasing', () => {
    assert.equal(
      assistantSpokeTeamHandoff("I'll pass that straight to the bakery for you."),
      true,
    );
    assert.equal(
      assistantSpokeTeamHandoff("No bother — I'll pass that to the team."),
      true,
    );
  });

  it('flags thanks for that as banned slop', () => {
    assert.equal(assistantUsesBannedAiSlop('Gotcha, thanks for that. Are you all sorted?'), true);
  });

  it('builds post-confirm spelling steer without thanks for that', () => {
    const steer = buildPostConfirmSpellingSteer('Brendan');
    assert.match(steer, /thanks for that/i);
    assert.match(steer, /Do NOT/i);
  });
});
