import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCaraCallPrompt } from './cara_prompt.js';
import { CaraTools } from './cara_tools.js';

const baseInput = {
  businessName: 'Hello Cara Demo',
  customPrompt: '',
  callerLine: {
    kind: 'irish_mobile' as const,
    e164: '+353871234567',
    spoken: 'oh-eight-seven, one-two-three, four-five-six-seven',
    display: '087 123 4567',
    canReceiveSms: true,
    hint: 'Caller ID on file.',
  },
  routingLinks: [],
  orgTimeZone: 'Europe/Dublin',
  nowUtcIso: '2026-06-20T12:00:00.000Z',
  todayLocal: '2026-06-20',
};

describe('demo conversational line', () => {
  it('uses a compact demo prompt with opening arc and playbooks', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /Hello Cara demo line/i);
    assert.match(prompt, /Opening \(greeting already played\)/i);
    assert.match(prompt, /just so you're aware/i);
    assert.match(prompt, /how are you keeping/i);
    assert.match(prompt, /Scenario playbooks/i);
    assert.match(prompt, /endPhoneCall/i);
    assert.ok(prompt.length < 12000, 'demo prompt should stay compact');
    assert.doesNotMatch(prompt, /Sound human \(this is the whole job\)/i);
    assert.doesNotMatch(prompt, /spoken automatically/i);
  });

  it('registers only endPhoneCall on the demo tool surface', () => {
    const tools = new CaraTools().toolContext({ demoLine: true });

    assert.deepEqual(Object.keys(tools).sort(), ['endPhoneCall']);
  });

  it('embeds scenario playbooks as guidance not scripts', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /paraphrase, never read verbatim/i);
    assert.match(prompt, /### Electrician/i);
  });

  it('winds down with endPhoneCall when caller sounds finished', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /Ending calls/i);
    assert.match(prompt, /is that everything/i);
    assert.match(prompt, /thanks for calling Hello Cara today/i);
    assert.match(prompt, /Bye for now/i);
    assert.match(prompt, /endPhoneCall/i);
    assert.match(prompt, /Never say "grand" or "sound"/i);
    assert.match(prompt, /one outro only/i);
    assert.match(prompt, /no separate.*Lovely/i);
    assert.match(prompt, /Rotate openers/i);
    assert.match(prompt, /\[tool call\]/i);
    assert.match(prompt, /Never say the word "line" aloud/i);
    assert.match(prompt, /No emojis/i);
    assert.match(prompt, /No real business facts/i);
  });
});
