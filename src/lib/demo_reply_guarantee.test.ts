import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDemoNeverSilentSteer,
  buildDemoSilenceWatchdogSteer,
} from './demo_reply_guarantee.js';

describe('demo_reply_guarantee', () => {
  it('forces speech for any caller line', () => {
    assert.match(buildDemoNeverSilentSteer('hello'), /MUST speak/i);
    assert.match(buildDemoNeverSilentSteer(''), /MUST speak/i);
  });

  it('routes product questions through about steer', () => {
    assert.match(
      buildDemoNeverSilentSteer('What is it that you do?'),
      /what Hello Cara does/i,
    );
  });

  it('watchdog steer is stronger than the fast guarantee', () => {
    assert.match(buildDemoSilenceWatchdogSteer('Are you there?'), /did not reach/i);
  });
});
