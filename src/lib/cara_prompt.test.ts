import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCaraCallPrompt } from './cara_prompt.js';
import { pickCallPersona } from './persona.js';

const baseInput = {
  businessName: 'Murphy\'s SuperValu Killarney',
  customPrompt: 'We are a grocery store.',
  callerLine: {
    kind: 'irish_mobile' as const,
    e164: '+353871234567',
    spoken: 'oh-eight-seven, one-two-three, four-five-six-seven',
    display: '087 123 4567',
    canReceiveSms: true,
    hint: 'Caller ID on file.',
  },
  routingLinks: [],
  bookingTimeZone: 'Europe/Dublin',
  nowUtcIso: '2026-06-20T12:00:00.000Z',
  todayLocal: '2026-06-20',
};

describe('buildCaraCallPrompt', () => {
  it('includes fallback guidance for unknown topics', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      niche: 'retail',
    });

    assert.match(prompt, /do \*\*not\*\* guess/i);
    assert.match(prompt, /takeCallbackMessage/i);
  });

  it('uses retail flow without booking language', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      niche: 'retail',
      businessType: 'Retail & Grocery',
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /retail store/i);
    assert.match(prompt, /greeting already played/i);
    assert.match(prompt, /can you hear me/i);
    assert.doesNotMatch(prompt, /sendBookingLink/i);
    assert.doesNotMatch(prompt, /salon/i);
    assert.doesNotMatch(prompt, /root touch-up/i);
  });

  it('uses conversational demo prompt on the test line', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      businessName: 'Hello Cara Demo',
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /Hello Cara demo line/i);
    assert.match(prompt, /not a real shop/i);
    assert.match(prompt, /recorded and transcribed|recording\/transcription notice/i);
    assert.match(prompt, /do not guess names like Patricia/i);
    assert.doesNotMatch(prompt, /Murphy/i);
  });

  it('includes chatty host personality and intent routing on demo line', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      businessName: 'Hello Cara Demo',
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /Host personality \(chatty demo host\)/i);
    assert.match(prompt, /Intent routing/i);
    assert.match(prompt, /Explore.*can you hear me/i);
    assert.match(prompt, /Human speech \(not a phone menu\)/i);
    assert.match(prompt, /Never.*list trades/i);
    assert.match(prompt, /Never.*say \*"demo line"\*/i);
  });

  it('embeds all scenario playbooks including general non-trade path', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      businessName: 'Hello Cara Demo',
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /### Electrician/i);
    assert.match(prompt, /### Salon/i);
    assert.match(prompt, /### Mechanic/i);
    assert.match(prompt, /### Shop \/ retail/i);
    assert.match(prompt, /### General Hello Cara/i);
    assert.match(prompt, /How are you keeping today/i);
    assert.match(prompt, /paraphrase/i);
  });

  it('includes demo personality and name banter guidance', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      businessName: 'Hello Cara Demo',
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /Personality & humour/i);
    assert.match(prompt, /Are you sure that's your name/i);
    assert.match(prompt, /Who am I talking to/i);
  });

  it('accepts injected demoPlaybookBlock override', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      businessName: 'Hello Cara Demo',
      demoMode: true,
      openingGreetingDelivered: true,
      demoPlaybookBlock: '### Custom playbook\nTriggers: test\n  1. **Beat** — guidance',
    });

    assert.match(prompt, /Custom playbook/);
    assert.doesNotMatch(prompt, /### Electrician/);
  });

  it('includes conversational sections and persona block last on production calls', () => {
    const persona = pickCallPersona({
      businessName: baseInput.businessName,
      seed: 'org-1:+353871234567:room-a',
      localHour: 14,
    });
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      niche: 'retail',
      persona,
    });

    assert.match(prompt, /## Who you are/i);
    assert.match(prompt, /## How you talk/i);
    assert.match(prompt, /## Never sound like a machine/i);
    assert.match(prompt, /## Your manner on this call/i);
    assert.match(prompt, /endPhoneCall in the same turn/i);
    assert.ok(prompt.includes(persona.greeting));
    assert.doesNotMatch(prompt, /\{business\}|\{timeOfDay\}/);
    assert.ok(
      prompt.lastIndexOf('## Your manner on this call') >
        prompt.indexOf('## Active routes'),
    );
  });

  it('keeps a large shared prefix across different caller personas', () => {
    const shared = {
      ...baseInput,
      niche: 'retail',
      customPrompt: 'We are a grocery store with a deli counter.',
      routingLinks: [],
    };
    const p1 = buildCaraCallPrompt({
      ...shared,
      callerLine: { ...baseInput.callerLine, display: '087 111 1111', e164: '+353871111111' },
      persona: pickCallPersona({
        businessName: shared.businessName,
        seed: 'org:+353871111111:room-1',
      }),
    });
    const p2 = buildCaraCallPrompt({
      ...shared,
      callerLine: { ...baseInput.callerLine, display: '087 222 2222', e164: '+353872222222' },
      persona: pickCallPersona({
        businessName: shared.businessName,
        seed: 'org:+353872222222:room-2',
      }),
    });

    let prefix = 0;
    const limit = Math.min(p1.length, p2.length);
    while (prefix < limit && p1[prefix] === p2[prefix]) prefix += 1;
    const ratio = prefix / Math.max(p1.length, p2.length);
    assert.ok(ratio >= 0.75, `shared prefix ratio ${ratio.toFixed(2)} below 0.75`);
  });
});
