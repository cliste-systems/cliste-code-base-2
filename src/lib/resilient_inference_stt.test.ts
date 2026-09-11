import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifySttPipelineError,
  isSttRateLimitOrTransientError,
  resolveCallOutcomeWithSttFailure,
  STT_FAILURE_AI_SUMMARY,
} from './resilient_inference_stt.js';
import { shouldUseDemoExperienceStack } from './conversational_retail_line.js';

describe('resilient_inference_stt', () => {
  it('detects STT 429 and transient errors', () => {
    assert.equal(
      isSttRateLimitOrTransientError(
        '{"type":"stt_error","error":{"statusCode":429}}',
      ),
      true,
    );
    assert.equal(isSttRateLimitOrTransientError('Unexpected server response: 429'), true);
    assert.equal(isSttRateLimitOrTransientError('STT timeout', new Error('503 Service Unavailable')), true);
    assert.equal(isSttRateLimitOrTransientError('STT decode failed'), false);
  });

  it('classifies pipeline STT errors as retryable for 429/503', () => {
    const rateLimit = classifySttPipelineError(
      '{"type":"stt_error","error":{"statusCode":429,"recoverable":false}}',
    );
    assert.equal(rateLimit.retryable, true);
    assert.equal(rateLimit.statusCode, 429);

    const ok = classifySttPipelineError('tts synthesize failed');
    assert.equal(ok.retryable, false);
  });

  it('does not use demo experience stack for conversational retail alone', () => {
    assert.equal(
      shouldUseDemoExperienceStack({
        testCall: false,
        conversationalRetailLine: true,
      }),
      false,
    );
  });

  it('maps empty transcript + STT failure to stt_failure outcome', () => {
    const result = resolveCallOutcomeWithSttFailure({
      transcriptLineCount: 0,
      sttFailureDetected: true,
    });
    assert.ok(result);
    assert.equal(result.outcome, 'stt_failure');
    assert.equal(result.aiSummary, STT_FAILURE_AI_SUMMARY);
  });

  it('returns null when transcript exists despite STT error', () => {
    const result = resolveCallOutcomeWithSttFailure({
      transcriptLineCount: 3,
      sttFailureDetected: true,
    });
    assert.equal(result, null);
  });
});
