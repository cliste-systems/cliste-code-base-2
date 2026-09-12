import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  executePostCallActions,
  fallbackExtractPostCallActions,
  normalizePostCallActions,
} from './post_call_actions.js';

describe('normalizePostCallActions', () => {
  it('parses valid action_ticket and manager_callback', () => {
    const actions = normalizePostCallActions([
      {
        type: 'action_ticket',
        callerName: 'Timmy',
        summary: 'Birthday cake for Mary on the 12th of next month for 7 people.',
        routeId: 'retail-bakery-cake',
      },
      {
        type: 'manager_callback',
        callerName: 'Sarah',
        reason: 'Complaint about delivery yesterday',
      },
      { type: 'action_ticket', callerName: 'caller', summary: 'too short' },
    ]);

    assert.equal(actions.length, 2);
    assert.equal(actions[0]?.type, 'action_ticket');
    assert.equal(actions[1]?.type, 'manager_callback');
  });

  it('dedupes identical actions', () => {
    const actions = normalizePostCallActions([
      {
        type: 'action_ticket',
        callerName: 'Timmy',
        summary: 'Birthday cake for Mary on the 12th of next month.',
        routeId: 'retail-bakery-cake',
      },
      {
        type: 'action_ticket',
        callerName: 'Timmy',
        summary: 'Birthday cake for Mary on the 12th of next month.',
        routeId: 'retail-bakery-cake',
      },
    ]);
    assert.equal(actions.length, 1);
  });
});

describe('fallbackExtractPostCallActions', () => {
  const timmyTranscript = `Assistant: Hello, you're through to Kavanaghs SuperValu Donegal Town. I'm Cara, the AI assistant. This call may be recorded and transcribed. How can I help you today?

Caller: Hello there, just wondering, um, Can I do a cake order, please?

Caller: My name is Timmy.

Caller: Um, I want a birthday cake and I want it for the 12th.

Caller: Which— no, sorry, the 12th of next month.

Caller: 7.

Caller: Happy birthday, Mary.`;

  it('extracts cake order from Timmy fixture transcript', () => {
    const actions = fallbackExtractPostCallActions(timmyTranscript);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.type, 'action_ticket');
    assert.equal(actions[0]?.callerName, 'Timmy');
    assert.match(actions[0]?.summary ?? '', /Birthday cake/i);
  });
});

describe('executePostCallActions', () => {
  it('returns empty result when no actions provided', async () => {
    const result = await executePostCallActions({
      organizationId: 'org-1',
      calledNumber: '+353749759508',
      callerNumber: '+353872715938',
      actions: [],
    });
    assert.equal(result.actionTicketCreated, false);
    assert.equal(result.executed.length, 0);
    assert.equal(result.errors.length, 0);
  });
});
