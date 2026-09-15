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

  it('extracts cake order without caller name when errand was confirmed', () => {
    const jamieTranscript = `Assistant: Brilliant — and what date do you need that for?

Caller: And he's off Tuesday the 15th.

Assistant: Lovely — so that's a birthday cake for Jamie for tomorrow, Tuesday the 15th, with blue icing and "Happy Birthday Jamie" on it, for 13 people. Is that all correct?

Caller: Yeah, that's everything.`;

    const actions = fallbackExtractPostCallActions(jamieTranscript);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.type, 'action_ticket');
    assert.match(actions[0]?.summary ?? '', /Birthday cake order/i);
    assert.match(actions[0]?.summary ?? '', /For: Jamie/i);
    assert.match(actions[0]?.summary ?? '', /Size: 13 people/i);
  });

  it('extracts inch cake size from confirmation summary', () => {
    const transcript = `Assistant: Lovely — so that's an 8-inch chocolate birthday cake for Sean for Friday with "Happy Birthday Sean" on it. Is that all correct?
Caller: Yeah, perfect.`;

    const actions = fallbackExtractPostCallActions(transcript);
    assert.equal(actions.length, 1);
    assert.match(actions[0]?.summary ?? '', /Size: 8-inch/i);
  });

  it('keeps cake name and collecting name separate when both were given', () => {
    const brandonTranscript = `Assistant: Gotcha — and what name would you like on the cake?

Caller: Brandon.

Assistant: And your first name for collection?

Caller: Brendan.

Assistant: Lovely — so that's a vanilla birthday cake for Brandon for tomorrow, Tuesday, with blue icing and "Happy Birthday" on it — collecting under Brendan. Is that all correct?

Caller: That's perfect.`;

    const actions = fallbackExtractPostCallActions(brandonTranscript);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.type, 'action_ticket');
    if (actions[0]?.type === 'action_ticket') {
      assert.match(actions[0].summary ?? '', /For: Brandon/i);
      assert.match(actions[0].summary ?? '', /Collecting: Brendan/i);
    }
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
