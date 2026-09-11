import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assistantTextSoundsLikeDemoFarewell,
  assistantTextSoundsLikeGoodbye,
  assistantTextSoundsLikeTerminalHangup,
  buildWarmCallClosingLine,
} from './end_call.js';

describe('end_call goodbye detector', () => {
  it('matches prompt-style closings', () => {
    assert.equal(assistantTextSoundsLikeGoodbye('Lovely, thanks for calling Brandon. Bye!'), true);
    assert.equal(assistantTextSoundsLikeGoodbye('Thanks for calling. Goodbye!'), true);
    assert.equal(
      assistantTextSoundsLikeGoodbye('Lovely, thanks for calling Bloom Beauty Studio. Bye!'),
      true,
    );
  });

  it('builds warm programmatic closing without grand or bare bye', () => {
    const line = buildWarmCallClosingLine(
      {
        name: "Murphy's SuperValu Killarney",
        greeting:
          "You're through to Murphy's SuperValu Killarney — I'm Cara, the AI assistant.",
      },
      'test-call-seed',
    );
    assert.match(line, /thanks for (ringing|calling) Murphy's SuperValu/i);
    assert.doesNotMatch(line, /Killarney/i);
    assert.match(line, /(take care|have a good one|glad I could help|no bother)/i);
    assert.doesNotMatch(line, /\bbye\b/i);
    assert.doesNotMatch(line, /grand/i);
  });

  it('detects terminal hangup lines without bare bye', () => {
    assert.equal(
      assistantTextSoundsLikeTerminalHangup('Lovely — thanks for calling. Take care.'),
      true,
    );
    assert.equal(assistantTextSoundsLikeTerminalHangup('Lovely, thanks for calling Murphy\'s. Bye!'), true);
    assert.equal(
      assistantTextSoundsLikeTerminalHangup("You're welcome, have a great day."),
      false,
    );
    assert.equal(
      assistantTextSoundsLikeTerminalHangup('Is there anything else I can help you with?'),
      false,
    );
  });

  it('matches agent auto-close string pattern', () => {
    assert.equal(
      assistantTextSoundsLikeGoodbye('Lovely, thanks for calling Bloom Beauty Studio. Bye!'),
      true,
    );
  });

  it('does not match anything-else check (question)', () => {
    assert.equal(
      assistantTextSoundsLikeGoodbye('Is there anything else I can help you with?'),
      false,
    );
  });

  it('detects demo conversational farewells for auto-hangup', () => {
    assert.equal(
      assistantTextSoundsLikeDemoFarewell('No bother, Francis — I\'ll leave you to it. Take care.'),
      true,
    );
    assert.equal(
      assistantTextSoundsLikeDemoFarewell('Thanks, Francis — take care now.'),
      true,
    );
    assert.equal(
      assistantTextSoundsLikeDemoFarewell(
        'Grand Abigail — I\u2019ll leave you to it. Take care now. \u{1F44B}',
      ),
      true,
    );
    assert.equal(
      assistantTextSoundsLikeDemoFarewell('No bother, Abigail — take care now.'),
      true,
    );
    assert.equal(
      assistantTextSoundsLikeDemoFarewell(
        'Lovely — for a salon I can handle calls while you\'re busy and take care of messages.',
      ),
      false,
    );
    assert.equal(
      assistantTextSoundsLikeDemoFarewell('Is there anything else I can help you with?'),
      false,
    );
    assert.equal(
      assistantTextSoundsLikeDemoFarewell(
        'Lovely, Martin — thanks for calling Hello Cara today. Have a good day. Bye for now. [tool call] Might need actually invoke tool, not textual.',
      ),
      true,
    );
  });
});
