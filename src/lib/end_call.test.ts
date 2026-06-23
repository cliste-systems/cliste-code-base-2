import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assistantTextSoundsLikeGoodbye } from './end_call.js';

describe('end_call goodbye detector', () => {
  it('matches prompt-style closings', () => {
    assert.equal(assistantTextSoundsLikeGoodbye('Lovely, thanks for calling Brandon. Bye!'), true);
    assert.equal(assistantTextSoundsLikeGoodbye('Thanks for calling. Goodbye!'), true);
    assert.equal(
      assistantTextSoundsLikeGoodbye('Lovely, thanks for calling Bloom Beauty Studio. Bye!'),
      true,
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
});
