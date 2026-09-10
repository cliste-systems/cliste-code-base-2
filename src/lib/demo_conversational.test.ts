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
  bookingTimeZone: 'Europe/Dublin',
  nowUtcIso: '2026-06-20T12:00:00.000Z',
  todayLocal: '2026-06-20',
};

describe('demo conversational line', () => {
  it('prompts the LLM to own name, recording notice, and chitchat', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /Opening arc \(your job after the greeting — one turn each\)/i);
    assert.match(prompt, /ack \+ recording notice/i);
    assert.match(prompt, /How are you keeping/i);
    assert.match(prompt, /never deliver the recording notice and a \*how are you keeping/i);
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

    assert.match(prompt, /Scenario playbooks/i);
    assert.match(prompt, /paraphrase/i);
    assert.match(prompt, /endPhoneCall/i);
  });

  it('requires one idea per turn and no feature dump plus question', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /One capability or idea per turn/i);
    assert.match(prompt, /Never rattle off features and end with a question/i);
  });

  it('winds down and endPhoneCall when caller sounds finished without waiting for bye', () => {
    const prompt = buildCaraCallPrompt({
      ...baseInput,
      demoMode: true,
      openingGreetingDelivered: true,
    });

    assert.match(prompt, /that's all/i);
    assert.match(prompt, /endPhoneCall in the same turn/i);
    assert.match(prompt, /Do not wait for \*"bye"\*/i);
  });
});
