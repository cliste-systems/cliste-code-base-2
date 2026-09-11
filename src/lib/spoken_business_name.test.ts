import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveSpokenBusinessName } from './spoken_business_name.js';

describe('resolveSpokenBusinessName', () => {
  it('drops trailing town from retail banner names by default', () => {
    assert.equal(
      resolveSpokenBusinessName({
        name: "Murphy's SuperValu Killarney",
        greeting:
          "You're through to Murphy's SuperValu Killarney — I'm Cara, the AI assistant.",
      }),
      "Murphy's SuperValu",
    );
  });

  it('keeps location when preserveRetailLocation is set', () => {
    assert.equal(
      resolveSpokenBusinessName({
        name: 'Kavanaghs SuperValu Donegal Town',
        preserveRetailLocation: true,
      }),
      'Kavanaghs SuperValu Donegal Town',
    );
  });

  it('strips configured base town suffix', () => {
    assert.equal(
      resolveSpokenBusinessName({
        name: 'Bloom Beauty Studio Letterkenny',
        agentBaseTown: 'Letterkenny',
      }),
      'Bloom Beauty Studio',
    );
  });

  it('falls back to org name when no shortening applies', () => {
    assert.equal(
      resolveSpokenBusinessName({ name: 'Last Look Hair' }),
      'Last Look Hair',
    );
  });
});
