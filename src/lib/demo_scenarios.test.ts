import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_DEMO_SCENARIOS,
  detectDemoScenario,
  formatDemoBeatHint,
  formatDemoScenariosForPrompt,
  getDemoScenarioBySlug,
} from './demo_scenarios.js';

describe('demo_scenarios', () => {
  it('detects trade scenarios before general', () => {
    assert.equal(detectDemoScenario('Can we demo an electrician?'), 'electrician');
    assert.equal(detectDemoScenario('What is Hello Cara?'), 'general');
    assert.equal(detectDemoScenario('I need an electrician for hello cara'), 'electrician');
    assert.equal(detectDemoScenario("I'm a plumber, what can Cara do?"), 'general');
  });

  it('returns null for unrelated explore utterances', () => {
    assert.equal(detectDemoScenario('Can you hear me?'), null);
    assert.equal(detectDemoScenario('Hello?'), null);
  });

  it('formats beat hints with guidance and suggested line', () => {
    const hint = formatDemoBeatHint('electrician', 1);
    assert.ok(hint);
    assert.match(hint!, /beat 2\/4/i);
    assert.match(hint!, /Invite role-play/i);
    assert.match(hint!, /tripped fuse/i);
  });

  it('embeds all five playbooks for prompt injection', () => {
    const block = formatDemoScenariosForPrompt();
    for (const slug of ['electrician', 'salon', 'mechanic', 'retail', 'general']) {
      assert.match(block, new RegExp(`\`${slug}\``));
    }
    assert.equal(getDemoScenarioBySlug('salon', DEFAULT_DEMO_SCENARIOS)?.beats.length, 4);
  });
});
