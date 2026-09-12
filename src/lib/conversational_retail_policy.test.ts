import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isPlaceholderCallerName,
  staffSummaryLooksLikeSpeechOnlyQuestion,
} from './conversational_retail_policy.js';

describe('conversational_retail_policy', () => {
  it('detects placeholder caller names', () => {
    assert.equal(isPlaceholderCallerName('caller'), true);
    assert.equal(isPlaceholderCallerName('Mary'), false);
  });

  it('flags hours summaries as speech-only', () => {
    assert.equal(
      staffSummaryLooksLikeSpeechOnlyQuestion('Caller asked about store opening hours.'),
      true,
    );
    assert.equal(
      staffSummaryLooksLikeSpeechOnlyQuestion(
        'Birthday cake for Tuesday, happy birthday Mary, 20 servings.',
      ),
      false,
    );
  });
});
