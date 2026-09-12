import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BARE_LIVEKIT_DISABLED_PROGRAMMATIC_GUARDS,
  isBareLiveKitRetailLane,
} from './bare_livekit_retail_lane.js';

describe('bare_livekit_retail_lane', () => {
  it('identifies Kavanaghs 9508 as the bare LiveKit lane', () => {
    assert.equal(isBareLiveKitRetailLane('+353749759508'), true);
    assert.equal(isBareLiveKitRetailLane('+353749389378'), false);
  });

  it('documents programmatic guards disabled on bare lane', () => {
    assert.ok(BARE_LIVEKIT_DISABLED_PROGRAMMATIC_GUARDS.includes('resetDeadAirTimer'));
    assert.ok(BARE_LIVEKIT_DISABLED_PROGRAMMATIC_GUARDS.includes('scheduleCallerReplyNudge'));
    assert.ok(BARE_LIVEKIT_DISABLED_PROGRAMMATIC_GUARDS.includes('scheduleGreetingInterruptFallback'));
    assert.ok(BARE_LIVEKIT_DISABLED_PROGRAMMATIC_GUARDS.includes('retryFailedReplyOnce'));
    assert.ok(BARE_LIVEKIT_DISABLED_PROGRAMMATIC_GUARDS.includes('steerReply'));
    assert.equal(BARE_LIVEKIT_DISABLED_PROGRAMMATIC_GUARDS.length, 7);
  });

  it('loop fix on 9508 is prompt-only — no runtime guard rails re-added', () => {
    assert.ok(BARE_LIVEKIT_DISABLED_PROGRAMMATIC_GUARDS.includes('maybeCloseAfterAnythingElse'));
    assert.ok(BARE_LIVEKIT_DISABLED_PROGRAMMATIC_GUARDS.includes('playPipelineRecoverySpeech'));
  });
});
