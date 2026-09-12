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
    assert.match(prompt, /Not a real shop/i);
    assert.match(prompt, /just so you're aware/i);
    assert.match(prompt, /how are you keeping/i);
    assert.match(prompt, /never guess/i);
    assert.doesNotMatch(prompt, /Murphy/i);
  });

  it('uses compact persona guidance instead of the old rulebook sections', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      businessName: 'Hello Cara Demo',
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /Who you are/i);
    assert.match(prompt, /paraphrase, never read verbatim/i);
    assert.doesNotMatch(prompt, /Host personality/i);
    assert.doesNotMatch(prompt, /Intent routing/i);
    assert.doesNotMatch(prompt, /Sound human \(this is the whole job\)/i);
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
    assert.match(prompt, /what brought them/i);
    assert.match(prompt, /paraphrase/i);
  });

  it('includes demo endPhoneCall guidance', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      businessName: 'Hello Cara Demo',
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /endPhoneCall/i);
    assert.match(prompt, /how are you keeping/i);
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

  it('uses LLM-first conversational retail prompt with call flow and manner blocks', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      businessName: 'Kavanaghs SuperValu Donegal Town',
      niche: 'retail',
      businessType: 'Retail & Grocery',
      conversationalRetailMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /programmatic/i);
    assert.match(prompt, /how can I help you today/i);
    assert.match(prompt, /CALL FLOW/i);
    assert.match(prompt, /## Sound human/i);
    assert.match(prompt, /endPhoneCall/i);
    assert.match(prompt, /Kavanaghs SuperValu Donegal Town/);
    assert.match(prompt, /after hang-up/i);
    assert.match(prompt, /Every turn must include spoken words/i);
    assert.match(prompt, /Never.*would you like to place an order/i);
    assert.match(prompt, /endPhoneCall.*only/i);
    assert.match(prompt, /Ignore any business instruction to use takeCallbackMessage/i);
    assert.doesNotMatch(prompt, /Hello Cara demo line/i);
    assert.doesNotMatch(prompt, /## Your manner on this call/i);
  });

  it('includes universal ending-calls state machine on conversational retail 9508', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      businessName: 'Kavanaghs SuperValu Donegal Town',
      niche: 'retail',
      conversationalRetailMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /## Ending calls/i);
    assert.match(prompt, /Beat 1/i);
    assert.match(prompt, /Beat 2/i);
    assert.match(prompt, /meaning in context/i);
    assert.match(prompt, /endPhoneCall.*same turn/i);
    assert.match(prompt, /Never.*dangling goodbye/i);
    assert.match(prompt, /Ignore any business instruction to use takeCallbackMessage/i);
    assert.match(prompt, /Finish.*Ending calls/i);
    assert.match(prompt, /summarising what you captured for their errand/i);
    assert.match(prompt, /## Confirm once/i);
    assert.match(prompt, /Never.*ask the same confirmation twice/i);
    assert.match(prompt, /Beat 1.*exactly once per call/i);
    assert.match(prompt, /Cake close:/i);
    assert.match(prompt, /banned slop phrase.*failure/i);
    assert.match(prompt, /never.*ask them to confirm.*phone number/i);
    assert.doesNotMatch(prompt, /best number to contact you on/i);
    assert.doesNotMatch(prompt, /Wind-down.*Ending calls beat 1/i);
  });

  it('excludes retail-hours callback route from conversational retail prompt', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      businessName: 'Kavanaghs SuperValu Donegal Town',
      niche: 'retail',
      conversationalRetailMode: true,
      openingGreetingDelivered: true,
      routingLinks: [
        {
          id: 'retail-hours',
          presetId: 'hours-enquiry',
          label: 'Opening hours',
          intent: 'opening hours',
          targetType: 'callback',
          url: 'Name, phone',
          active: true,
        },
        {
          id: 'retail-bakery-cake',
          presetId: 'quote',
          label: 'Birthday cake',
          intent: 'birthday cake',
          targetType: 'callback',
          url: 'Name, phone, cake',
          active: true,
        },
      ],
    });

    assert.doesNotMatch(prompt, /retail-hours/);
    assert.match(prompt, /retail-bakery-cake.*takeCallbackMessage/);
    assert.match(prompt, /Opening hours \(speech only/i);
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

  it('includes persona manner block on demo line when provided', () => {
    const persona = pickCallPersona({
      businessName: 'Hello Cara',
      seed: 'demo-seed',
      localHour: 10,
    });
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      businessName: 'Hello Cara Demo',
      demoMode: true,
      openingGreetingDelivered: true,
      persona,
    });

    assert.match(prompt, /## Your manner on this call/i);
    assert.match(prompt, /endPhoneCall/i);
    assert.ok(prompt.includes(persona.manner));
  });
});
