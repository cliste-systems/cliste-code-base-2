import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  filterKnowledgeGapsForStructuredHours,
  normalizePostprocessKnowledgeGaps,
  parsePostprocessJsonPayload,
} from './call_postprocess.js';
import { normalizePostCallActions } from './post_call_actions.js';

describe('normalizePostprocessKnowledgeGaps', () => {
  it('parses valid gaps and drops invalid entries', () => {
    const gaps = normalizePostprocessKnowledgeGaps([
      {
        topic: 'Balayage',
        caller_context: 'Caller asked about balayage colour.',
        suggested_section: 'services',
      },
      { topic: '   ' },
      { cara_question: 'missing topic' },
    ]);

    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.topic, 'Balayage');
    assert.equal(gaps[0]?.caller_context, 'Caller asked about balayage colour.');
    assert.equal(gaps[0]?.suggested_section, 'services');
  });

  it('returns empty when action ticket already created', () => {
    const gaps = normalizePostprocessKnowledgeGaps(
      [{ topic: 'Emergency callout' }],
      { actionTicketCreated: true },
    );
    assert.deepEqual(gaps, []);
  });
});

describe('filterKnowledgeGapsForStructuredHours', () => {
  const hoursConfig = {
    monday: { open: '09:00', close: '18:00' },
    bank_holidays: { configured: true, open: false },
  };

  it('drops St Patrick and opening-hours gaps when structured hours exist', () => {
    const gaps = filterKnowledgeGapsForStructuredHours(
      [
        { topic: "St Patrick's Day opening hours" },
        { topic: 'Balayage', caller_context: 'Caller asked about balayage.' },
      ],
      hoursConfig,
    );
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.topic, 'Balayage');
  });

  it('passes all gaps through when no structured hours', () => {
    const gaps = filterKnowledgeGapsForStructuredHours(
      [{ topic: "St Patrick's Day opening hours" }],
      null,
    );
    assert.equal(gaps.length, 1);
  });
});

describe('parsePostprocessJsonPayload', () => {
  it('extracts knowledgeGaps from fenced JSON', () => {
    const parsed = parsePostprocessJsonPayload<{
      transcriptReview?: string;
      summary?: string;
      knowledgeGaps?: unknown;
    }>(`\`\`\`json
{
  "transcriptReview": "Caller: Hi\\nAssistant: Hello",
  "summary": "Caller asked about balayage.",
  "knowledgeGaps": [{ "topic": "Balayage" }]
}
\`\`\``);

    assert.ok(parsed?.transcriptReview?.includes('Caller:'));
    assert.equal(parsed?.summary, 'Caller asked about balayage.');
    const gaps = normalizePostprocessKnowledgeGaps(parsed?.knowledgeGaps);
    assert.equal(gaps[0]?.topic, 'Balayage');
  });

  it('extracts postCallActions from fenced JSON', () => {
    const parsed = parsePostprocessJsonPayload<{
      postCallActions?: unknown;
    }>(`\`\`\`json
{
  "transcriptReview": "Caller: cake order",
  "summary": "Cake order logged.",
  "knowledgeGaps": [],
  "postCallActions": [{
    "type": "action_ticket",
    "callerName": "Timmy",
    "summary": "Birthday cake for Mary on the 12th of next month for 7 people.",
    "routeId": "retail-bakery-cake"
  }]
}
\`\`\``);
    const actions = normalizePostCallActions(parsed?.postCallActions);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.callerName, 'Timmy');
  });
});
