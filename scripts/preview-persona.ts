#!/usr/bin/env npx tsx
/**
 * Print persona open/close lines for the next N synthetic calls — no phone call needed.
 *
 * Usage: npm run preview:persona -- "Hello Cara" 10
 */
import { buildDemoPersonaGreeting, countDemoOpeningWords, pickCallPersona } from '../src/lib/persona.js';

const businessName = process.argv[2]?.trim() || 'Hello Cara';
const count = Math.max(1, Math.min(50, Number.parseInt(process.argv[3] ?? '10', 10) || 10));

console.info(`Persona preview for "${businessName}" — next ${count} calls:\n`);

for (let i = 0; i < count; i += 1) {
  const seed = `preview-org:+353871234${String(i).padStart(3, '0')}:room-${i}`;
  const persona = pickCallPersona({ businessName, seed, localHour: 9 + (i % 10) });
  const spokenOpening = buildDemoPersonaGreeting(persona, seed);
  console.info(`Call ${i + 1} [${persona.variant}]`);
  console.info(`  Spoken: ${spokenOpening} (${countDemoOpeningWords(spokenOpening)} words)`);
  console.info(`  Manner: ${persona.manner}`);
  console.info(`  Acks:  ${persona.acknowledgements.join(', ')}`);
  console.info(`  Close: ${persona.signOff}`);
  console.info('');
}
