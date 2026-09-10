import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCallTranscriptCapture } from './call_transcript_capture.js';

describe('createCallTranscriptCapture', () => {
  it('dedupes identical assistant lines within the window', () => {
    const capture = createCallTranscriptCapture();
    const text = "You're through to Test Salon — how can I help?";
    capture.appendAssistantLine(text, 1000);
    capture.appendAssistantLine(text, 1500);
    const assistantLines = capture.parts.filter((p) => p.line.startsWith('Assistant:'));
    assert.equal(assistantLines.length, 1);
  });

  it('allows identical assistant lines outside the dedupe window', () => {
    const capture = createCallTranscriptCapture();
    const text = 'Same line again';
    capture.appendAssistantLine(text, 1000);
    capture.appendAssistantLine(text, 5000);
    const assistantLines = capture.parts.filter((p) => p.line.startsWith('Assistant:'));
    assert.equal(assistantLines.length, 2);
  });
});
