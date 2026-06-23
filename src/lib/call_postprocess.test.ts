import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizePostprocessKnowledgeGaps,
  parsePostprocessJsonPayload,
} from './call_postprocess.js';

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
});
