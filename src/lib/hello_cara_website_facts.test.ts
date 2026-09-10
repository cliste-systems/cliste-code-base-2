import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyHelloCaraAboutQuestion,
  HELLO_CARA_WHO_MADE_FACTS,
  HELLO_CARA_WHAT_WE_DO_THEMES,
  helloCaraAboutSteerInstructions,
} from './hello_cara_website_facts.js';

describe('hello_cara_website_facts', () => {
  it('classifies who-made and what-we-do questions', () => {
    assert.equal(classifyHelloCaraAboutQuestion('Who made you?'), 'who-made');
    assert.equal(classifyHelloCaraAboutQuestion('What do you do?'), 'what-we-do');
    assert.equal(classifyHelloCaraAboutQuestion('What is it that you do?'), 'what-we-do');
    assert.equal(classifyHelloCaraAboutQuestion('So how do you work?'), 'what-we-do');
    assert.equal(classifyHelloCaraAboutQuestion('What can we demo?'), null);
  });

  it('steer instructions require paraphrase not script reading', () => {
    assert.match(helloCaraAboutSteerInstructions('what-we-do'), /paraphrase/i);
    assert.match(helloCaraAboutSteerInstructions('who-made'), /Cliste Systems Limited/i);
    assert.doesNotMatch(helloCaraAboutSteerInstructions('what-we-do'), /Use these facts:/);
  });

  it('defines website themes for what-we-do and who-made facts', () => {
    assert.ok(HELLO_CARA_WHAT_WE_DO_THEMES.length >= 2);
    assert.equal(HELLO_CARA_WHO_MADE_FACTS.company, 'Cliste Systems Limited');
    assert.equal(HELLO_CARA_WHO_MADE_FACTS.location, 'Donegal');
  });
});
