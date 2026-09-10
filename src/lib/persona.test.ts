import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  measurePersonaSpread,
  pickCallPersona,
  personaVarietyEnabled,
  hashPersonaSeed,
} from './persona.js';

describe('persona', () => {
  it('is deterministic for a fixed seed', () => {
    const a = pickCallPersona({
      businessName: "Murphy's SuperValu",
      seed: 'org-1:+353871234567:room-abc',
      localHour: 14,
    });
    const b = pickCallPersona({
      businessName: "Murphy's SuperValu",
      seed: 'org-1:+353871234567:room-abc',
      localHour: 14,
    });
    assert.deepEqual(a, b);
  });

  it('does not leak placeholders into greeting', () => {
    for (let i = 0; i < 50; i += 1) {
      const p = pickCallPersona({
        businessName: 'Test Shop',
        seed: `seed-${i}`,
        localHour: i % 24,
      });
      assert.doesNotMatch(p.greeting, /\{business\}|\{salon\}|\{timeOfDay\}/);
    }
  });

  it('spreads variants evenly over many seeds', () => {
    const { distinctVariants, bankCounts } = measurePersonaSpread(5000);
    assert.ok(distinctVariants > 1200, `expected >1200 distinct, got ${distinctVariants}`);
    for (const counts of Object.values(bankCounts)) {
      const min = Math.min(...counts);
      const max = Math.max(...counts);
      assert.ok(min > 600, `bank min ${min} too low`);
      assert.ok(max < 1100, `bank max ${max} too high`);
    }
  });

  it('avoids low-bit collapse for consecutive seeds', () => {
    const greetings = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const p = pickCallPersona({
        businessName: 'Shop',
        seed: `org:x:+35387123456${i}:room-${i}`,
      });
      greetings.add(p.greeting);
    }
    assert.ok(greetings.size > 3, 'consecutive seeds should not collapse to one greeting');
  });

  it('pins to index 0 when variety is off', () => {
    const prev = process.env.CARA_PERSONA_VARIETY;
    process.env.CARA_PERSONA_VARIETY = 'off';
    try {
      const a = pickCallPersona({ businessName: 'A', seed: 'one', localHour: 9 });
      const b = pickCallPersona({ businessName: 'B', seed: 'two', localHour: 21 });
      assert.equal(a.variant, b.variant);
      assert.equal(a.variant, '0-0-0-0');
    } finally {
      if (prev === undefined) delete process.env.CARA_PERSONA_VARIETY;
      else process.env.CARA_PERSONA_VARIETY = prev;
    }
  });

  it('hashPersonaSeed avalanches similar strings', () => {
    const variants = new Set<number>();
    for (let i = 0; i < 20; i += 1) {
      variants.add(hashPersonaSeed(`test:room-${i}`) % 6);
    }
    assert.ok(variants.size > 1, 'similar seeds should not all map to one bucket');
  });

  it('personaVarietyEnabled defaults on', () => {
    const prev = process.env.CARA_PERSONA_VARIETY;
    delete process.env.CARA_PERSONA_VARIETY;
    delete process.env.SALON_PERSONA_VARIETY;
    try {
      assert.equal(personaVarietyEnabled(), true);
    } finally {
      if (prev !== undefined) process.env.CARA_PERSONA_VARIETY = prev;
    }
  });
});
