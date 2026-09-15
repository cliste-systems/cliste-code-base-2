import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  callRecordingStagingPath,
  callRecordingStoragePath,
} from './call_recording.js';

describe('call_recording paths', () => {
  it('builds final storage paths', () => {
    assert.equal(
      callRecordingStoragePath(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ),
      '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.mp3',
    );
  });

  it('builds sanitized staging paths per room', () => {
    assert.equal(
      callRecordingStagingPath(
        '11111111-1111-4111-8111-111111111111',
        'RM_abc-123',
      ),
      '11111111-1111-4111-8111-111111111111/.staging/RM_abc-123.mp3',
    );
  });
});
