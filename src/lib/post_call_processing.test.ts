import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeFinalPostCallStatus,
  PostCallProcessingTracker,
  withRetry,
} from './post_call_processing.js';

describe('computeFinalPostCallStatus', () => {
  it('returns complete when no errors and ticket not expected', () => {
    assert.equal(
      computeFinalPostCallStatus({
        errors: [],
        expectedTicket: false,
        actionTicketCreated: false,
        callLogId: 'call-1',
      }),
      'complete',
    );
  });

  it('returns failed when call log never persisted', () => {
    assert.equal(
      computeFinalPostCallStatus({
        errors: [{ stage: 'insert', message: 'boom', at: '2026-01-01T00:00:00.000Z' }],
        expectedTicket: true,
        actionTicketCreated: false,
        callLogId: null,
      }),
      'failed',
    );
  });

  it('returns failed when ticket expected but missing', () => {
    assert.equal(
      computeFinalPostCallStatus({
        errors: [{ stage: 'action_ticket', message: 'webhook failed', at: '2026-01-01T00:00:00.000Z' }],
        expectedTicket: true,
        actionTicketCreated: false,
        callLogId: 'call-1',
      }),
      'failed',
    );
  });

  it('returns partial when enrichment failed but ticket exists', () => {
    assert.equal(
      computeFinalPostCallStatus({
        errors: [{ stage: 'enrichment', message: 'patch failed', at: '2026-01-01T00:00:00.000Z' }],
        expectedTicket: true,
        actionTicketCreated: true,
        callLogId: 'call-1',
      }),
      'partial',
    );
  });
});

describe('PostCallProcessingTracker', () => {
  it('records errors and finalizes status', () => {
    const tracker = new PostCallProcessingTracker();
    tracker.expectedTicket = true;
    tracker.record('enrichment', 'missing ai summary');
    assert.equal(
      tracker.finalize({ actionTicketCreated: true, callLogId: 'abc' }),
      'partial',
    );
  });
});

describe('withRetry', () => {
  it('retries until success', async () => {
    let attempts = 0;
    const { value, error } = await withRetry('test', async () => {
      attempts += 1;
      if (attempts < 2) return null;
      return 'ok';
    }, 3);
    assert.equal(error, null);
    assert.equal(value, 'ok');
    assert.equal(attempts, 2);
  });
});
