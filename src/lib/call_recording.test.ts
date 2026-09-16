import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  callRecordingStagingPath,
  callRecordingStoragePath,
  isSupabaseS3Endpoint,
  resolveEgressS3Config,
  resolveSupabaseStorageS3Endpoint,
  stopActiveCallRecording,
} from './call_recording.js';

describe('resolveSupabaseStorageS3Endpoint', () => {
  it('uses the storage hostname for hosted Supabase projects', () => {
    assert.equal(
      resolveSupabaseStorageS3Endpoint('https://rtoebbwzwxcnscsxghww.supabase.co'),
      'https://rtoebbwzwxcnscsxghww.storage.supabase.co/storage/v1/s3',
    );
  });
});

describe('isSupabaseS3Endpoint', () => {
  it('detects Supabase storage endpoints', () => {
    assert.equal(
      isSupabaseS3Endpoint('https://abc.storage.supabase.co/storage/v1/s3'),
      true,
    );
    assert.equal(isSupabaseS3Endpoint('https://abc.r2.cloudflarestorage.com'), false);
  });
});

describe('resolveEgressS3Config', () => {
  it('rejects Supabase endpoints for LiveKit egress', () => {
    const original = { ...process.env };
    try {
      process.env.CALL_RECORDING_S3_ACCESS_KEY = 'test-access-key';
      process.env.CALL_RECORDING_S3_SECRET_KEY = 'test-secret-key';
      process.env.CALL_RECORDING_S3_ENDPOINT =
        'https://abc.storage.supabase.co/storage/v1/s3';
      assert.equal(resolveEgressS3Config(), null);
    } finally {
      process.env = original;
    }
  });
});

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

describe('stopActiveCallRecording', () => {
  it('is idempotent when already stopped', async () => {
    const state = {
      callRecordingEgressId: 'eg_test',
      callRecordingStoppedAtMs: 1_700_000_000_000,
    };
    assert.equal(await stopActiveCallRecording(state, 'test'), 1_700_000_000_000);
    assert.equal(state.callRecordingEgressId, 'eg_test');
  });

  it('returns null when no egress id', async () => {
    const state = { callRecordingEgressId: null, callRecordingStoppedAtMs: null };
    assert.equal(await stopActiveCallRecording(state, 'test'), null);
  });

  it('keeps egress id after stop so finalize can upload the MP3', async () => {
    const state = {
      callRecordingEgressId: 'eg_finalize_me',
      callRecordingStoppedAtMs: null,
    };
    const originalStop = process.env.LIVEKIT_URL;
    process.env.LIVEKIT_URL = '';
    try {
      const stoppedAtMs = await stopActiveCallRecording(state, 'caller_left');
      assert.ok(stoppedAtMs);
      assert.equal(state.callRecordingEgressId, 'eg_finalize_me');
      assert.equal(state.callRecordingStoppedAtMs, stoppedAtMs);
    } finally {
      if (originalStop === undefined) delete process.env.LIVEKIT_URL;
      else process.env.LIVEKIT_URL = originalStop;
    }
  });
});
