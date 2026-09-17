import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildActiveKnowledgeBlockForCall,
  isTemporalRowEffective,
} from './active_knowledge_for_call.js';

describe('active_knowledge_for_call', () => {
  it('marks effective temporal rows in window', () => {
    assert.equal(
      isTemporalRowEffective(
        {
          id: '1',
          title: 'Temporary opening hours',
          body: '8am–6pm',
          subject_type: 'opening_hours',
          subject_ref: 'fact-hours',
          override_preview: null,
          duration_mode: 'limited',
          effective_at: '2026-09-17T08:00:00.000Z',
          expires_at: '2026-09-18T00:00:00.000Z',
          ended_at: null,
          cancelled_at: null,
        },
        new Date('2026-09-17T14:33:51.000Z'),
      ),
      true,
    );
  });

  it('builds live override block from temporal rows and structured hours', () => {
    const block = buildActiveKnowledgeBlockForCall({
      temporalRows: [
        {
          id: '1',
          title: 'Temporary opening hours',
          body: '8am–6pm',
          subject_type: 'opening_hours',
          subject_ref: 'fact-hours',
          override_preview: {
            temporaryLabel: 'Temporary opening hours',
            temporaryBody: '8am–6pm',
            normalBody: '8am–9pm',
          },
          duration_mode: 'limited',
          effective_at: '2026-09-17T08:00:00.000Z',
          expires_at: '2026-09-18T00:00:00.000Z',
          ended_at: null,
          cancelled_at: null,
        },
      ],
      structuredHoursBlock:
        'Today (Thursday) — thursday: 8 o\'clock to 6 o\'clock.',
      now: new Date('2026-09-17T14:33:51.000Z'),
    });

    assert.match(block ?? '', /Active knowledge \(live/i);
    assert.match(block ?? '', /8am–6pm/);
    assert.match(block ?? '', /six o'clock|6 o'clock/i);
  });
});
