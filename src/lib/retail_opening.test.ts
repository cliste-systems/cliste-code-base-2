import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRetailConversationalOpening,
} from './conversational_retail_line.js';
import {
  buildRetailHelpPivot,
  buildRetailRecordingNotice,
  resolveRetailOpeningTurn,
  retailOpeningLooksLikeStoreQuestion,
} from './retail_opening.js';

describe('retail_opening', () => {
  it('builds recording notice and help pivot lines', () => {
    assert.equal(
      buildRetailRecordingNotice('Brendan'),
      'Perfect, Brendan — just so you\'re aware, this call may be recorded, yeah?',
    );
    assert.equal(
      buildRetailHelpPivot('Brendan'),
      'Perfect, Brendan, what can I help you with today?',
    );
  });

  it('includes please in the spoken retail opening', () => {
    assert.match(buildRetailConversationalOpening('Kavanaghs SuperValu Donegal Town'), /please\?/);
  });

  it('mirrors the 14:38 opening arc without looping', () => {
    let flags = {};

    const nameTurn = resolveRetailOpeningTurn('My name is Brendan.', flags);
    assert.equal(nameTurn.kind, 'recording_notice');
    if (nameTurn.kind !== 'recording_notice') return;
    flags = {
      retailCallerName: nameTurn.callerName,
      retailRecordingNoticePlayed: true,
    };

    const consentTurn = resolveRetailOpeningTurn("Yeah, that's fine.", flags);
    assert.equal(consentTurn.kind, 'help_pivot');
    if (consentTurn.kind !== 'help_pivot') return;
    assert.equal(consentTurn.line, 'Perfect, Brendan, what can I help you with today?');

    flags = { ...flags, retailOpeningComplete: true };
    assert.equal(resolveRetailOpeningTurn("Yeah, that's fine.", flags).kind, 'none');
  });

  it('defers to the LLM when the caller asks a store question instead of consenting', () => {
    const flags = {
      retailCallerName: 'Brendan',
      retailRecordingNoticePlayed: true,
    };
    assert.equal(
      resolveRetailOpeningTurn('Are you open on Sunday?', flags).kind,
      'defer_to_llm',
    );
    assert.equal(retailOpeningLooksLikeStoreQuestion("Yeah, that's fine."), false);
    assert.equal(retailOpeningLooksLikeStoreQuestion('Are you open on Sunday?'), true);
  });
});
