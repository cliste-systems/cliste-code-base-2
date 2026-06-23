import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessTranscriptCompleteness } from './transcript_completeness.js';

describe('assessTranscriptCompleteness', () => {
  it('accepts a normal two-sided transcript', () => {
    const result = assessTranscriptCompleteness(
      'Assistant: Hello\n\nCaller: Book please\n\nAssistant: Grand.',
    );
    assert.equal(result.complete, true);
    assert.equal(result.callerLineCount, 1);
    assert.equal(result.assistantLineCount, 2);
  });

  it('rejects empty transcript', () => {
    const result = assessTranscriptCompleteness('   ');
    assert.equal(result.complete, false);
    assert.match(result.reasons.join(' '), /empty/);
  });

  it('rejects assistant-only transcript', () => {
    const result = assessTranscriptCompleteness('Assistant: Hello there');
    assert.equal(result.complete, false);
    assert.match(result.reasons.join(' '), /no Caller/);
  });

  it('rejects reconstructed placeholder text', () => {
    const result = assessTranscriptCompleteness(
      'Assistant: Hi\n\nCaller: (inferred)\n\nAssistant: Bye',
    );
    assert.equal(result.complete, false);
    assert.match(result.reasons.join(' '), /placeholder/);
  });
});
