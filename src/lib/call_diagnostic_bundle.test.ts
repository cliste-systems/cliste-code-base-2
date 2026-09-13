import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzeTranscriptForIssues,
  buildCallDiagnosticBundle,
  extractToolLinesFromTranscript,
  formatDiagnosticMarkdown,
} from './call_diagnostic_bundle.js';

describe('call_diagnostic_bundle', () => {
  it('flags robotic wind-down and missing goodbye', () => {
    const transcript = [
      'Assistant: A patch test is a simple skin test.',
      'Assistant: Is there anything else I can help you with?',
      'Caller: No thanks',
      '[Tool] endPhoneCall {}',
    ].join('\n');
    const issues = analyzeTranscriptForIssues(transcript);
    assert.ok(issues.some((i) => /goodbye/i.test(i)));
  });

  it('flags duplicate greeting from test-line regression', () => {
    const transcript = [
      "Assistant: You're through to Murphy's SuperValu Killarney — I'm Cara, the AI assistant. How can I help you today?",
      "Assistant: You're through to Murphy's SuperValu Killarney — I'm Cara, the AI assistant. How can I help you today?",
      'Caller: Hello',
    ].join('\n\n');
    const issues = analyzeTranscriptForIssues(transcript);
    assert.ok(issues.some((i) => /Duplicate greeting/i.test(i)));
  });

  it('flags premature name intake and garbled manager fallback', () => {
    const transcript = [
      'Caller: What server value do you work for?',
      'Assistant: I do not have that detail. Could I take your name and number?',
    ].join('\n\n');
    const issues = analyzeTranscriptForIssues(transcript);
    assert.ok(issues.some((i) => /name\/number/i.test(i)));
  });

  it('flags bare bye closing', () => {
    const issues = analyzeTranscriptForIssues('Assistant: Bye.');
    assert.ok(issues.some((i) => /Bare "bye"/i.test(i)));
  });

  it('flags cut-off replies as caller-audible silence', () => {
    const transcript = [
      "Assistant: You're through to Hello Cara — what would you like to try?",
      'Caller: Can you hear me?',
      'Assistant: Yeah, I can hear you fine [cut off]',
    ].join('\n\n');
    const issues = analyzeTranscriptForIssues(transcript);
    assert.ok(issues.some((i) => /cut off/i.test(i)));
  });

  it('flags incomplete demo trade role-play on test calls', () => {
    const transcript = [
      "Assistant: You're through to Hello Cara — what would you like to try?",
      'Caller: Demo an electrician',
      'Assistant: Lovely — for an electrician I would answer every call.',
    ].join('\n');
    const issues = analyzeTranscriptForIssues(transcript, {
      isTestCall: true,
      demoScenarioSlug: 'electrician',
    });
    assert.ok(issues.some((i) => /missing role-play invitation/i.test(i)));
  });

  it('passes demo trade when role-play completes', () => {
    const transcript = [
      "Assistant: You're through to Hello Cara — what would you like to try?",
      'Caller: Demo an electrician',
      'Assistant: Lovely — want to try a quick example?',
      'Assistant: Perfect — pretend you are ringing about a tripped fuse.',
      'Caller: Hi, my fuse tripped and I need someone today.',
      'Assistant: No bother — I can take a message; what is the issue, is it urgent?',
      'Assistant: That is what your customers would hear — want another trade or are you sorted?',
    ].join('\n');
    const issues = analyzeTranscriptForIssues(transcript, {
      isTestCall: true,
      demoScenarioSlug: 'electrician',
    });
    assert.ok(!issues.some((i) => /missing role-play invitation/i.test(i)));
    assert.ok(!issues.some((i) => /missing wrap beat/i.test(i)));
  });

  it('extracts tool lines from transcript', () => {
    const lines = extractToolLinesFromTranscript(
      'Assistant: hi\n[Tool] sendRoutingLink {"routeId":"x"}\n[Tool result] ok',
    );
    assert.equal(lines.length, 2);
  });

  it('formats diagnostic markdown with deploy and events', () => {
    const bundle = buildCallDiagnosticBundle({
      callStartedAtMs: Date.UTC(2026, 5, 23, 18, 0, 0),
      callLogId: 'abc-123',
      transcript: 'Caller: hi\nAssistant: hello',
      events: [
        {
          atMs: Date.UTC(2026, 5, 23, 18, 0, 5),
          level: 'warn',
          tag: 'test',
          message: 'test',
        },
      ],
    });
    const md = formatDiagnosticMarkdown(bundle, Date.UTC(2026, 5, 23, 18, 0, 0));
    assert.match(md, /Diagnostic bundle/);
    assert.match(md, /Recommended checks/);
    assert.match(md, /Agent events/);
  });
});
