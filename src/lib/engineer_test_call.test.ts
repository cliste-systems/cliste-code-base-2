import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isEngineerTestCall,
  isEngineerTestCallerNumber,
  isEngineerTestRoomName,
} from './engineer_test_call.js';

describe('engineer_test_call', () => {
  it('detects admin simulator metadata', () => {
    assert.equal(
      isEngineerTestCall({
        jobMetadata: JSON.stringify({
          phone_number: '+353749759508',
          caller_number: '+353870000001',
          source: 'admin_simulator',
        }),
      }),
      true,
    );
  });

  it('detects fixed admin caller and room prefix', () => {
    assert.equal(isEngineerTestCallerNumber('+353870000001'), true);
    assert.equal(isEngineerTestRoomName('admin-demo-abc'), true);
    assert.equal(isEngineerTestCall({ callerNumber: '+353870000001' }), true);
    assert.equal(isEngineerTestCall({ roomName: 'admin-demo-xyz' }), true);
  });

  it('ignores normal customer calls', () => {
    assert.equal(isEngineerTestCallerNumber('+353871234567'), false);
    assert.equal(isEngineerTestRoomName('call-abc'), false);
    assert.equal(
      isEngineerTestCall({
        callerNumber: '+353871234567',
        roomName: 'voice-room-1',
      }),
      false,
    );
  });
});
