import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fallbackExtractKnowledgeGapsFromTranscript,
  filterKnowledgeGapsForRetailDynamicData,
  filterKnowledgeGapsForStructuredHours,
  isStructuredRetailDynamicKnowledge,
  normalizePostprocessKnowledgeGaps,
  parsePostprocessJsonPayload,
  postprocessCallTranscript,
  sanitizeOwnerFacingCallSummary,
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

});

describe('retail dynamic knowledge gap filtering', () => {
  it('treats arbitrary offer, price and stock questions as structured data rather than training', () => {
    for (const text of [
      'Weekly offers',
      'Ham discounts',
      'current promotions',
      'Cereal offers',
      "Are there any Kellogg's cereals on offer?",
      'How much are the Corn Flakes?',
      'Do you stock oat milk?',
    ]) {
      assert.equal(isStructuredRetailDynamicKnowledge(text), true, text);
    }

    assert.equal(
      isStructuredRetailDynamicKnowledge('Do you have a coin machine for change?'),
      false,
    );
    assert.equal(
      isStructuredRetailDynamicKnowledge(
        'How much notice is needed for a personalised birthday cake?',
      ),
      false,
    );
  });

  it('drops structured retail data gaps while retaining stable store knowledge', () => {
    const gaps = filterKnowledgeGapsForRetailDynamicData([
      {
        topic: 'Cereal offers',
        caller_context: "Are there any Kellogg's cereals on offer?",
      },
      {
        topic: 'Coin machine',
        caller_context: 'Do you have a coin machine for change?',
      },
    ]);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.topic, 'Coin machine');
  });

  it('does not fallback-extract an offer lookup failure as owner training', () => {
    const gaps = fallbackExtractKnowledgeGapsFromTranscript(
      [
        'Caller: Are there any cereals on offer?',
        "Assistant: I'm not sure, but I can check for you.",
      ].join('\n'),
    );
    assert.equal(gaps.length, 0);
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

describe('fallbackExtractKnowledgeGapsFromTranscript', () => {
  it('extracts teachable gaps when Cara was unsure', () => {
    const gaps = fallbackExtractKnowledgeGapsFromTranscript(
      [
        'Caller: Do you have a coin machine for change?',
        "Assistant: I'm not too sure on that one, but I can check for you.",
      ].join('\n'),
    );
    assert.equal(gaps[0]?.topic, 'Coin machine / change for cash');
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

describe('sanitizeOwnerFacingCallSummary', () => {
  it('replaces AI assistant phrasing with Cara in owner summaries', () => {
    assert.equal(
      sanitizeOwnerFacingCallSummary(
        'The call was connected, but the caller disconnected immediately after the AI assistant\'s greeting.',
      ),
      'The call was connected, but the caller disconnected immediately after Cara\'s greeting.',
    );
    assert.equal(
      sanitizeOwnerFacingCallSummary('The AI assistant answered and took a message.'),
      'Cara answered and took a message.',
    );
  });
});

describe('postprocessCallTranscript caller-heavy guard', () => {
  it('skips LLM reconstruction when assistant lines are missing from verbatim', async () => {
    const verbatim =
      'Assistant: Hello\n\nCaller: Are you open?\n\nCaller: Cake order please\n\nCaller: Brendan';
    const result = await postprocessCallTranscript({
      verbatim,
      businessName: 'Kavanaghs SuperValu Donegal Town',
      outcome: 'answered',
      inferenceLlmModel: 'openai/gpt-4.1',
      conversationalRetailLine: true,
    });
    assert.equal(result.transcriptReview, verbatim);
    assert.match(result.aiSummary, /Assistant lines missing from live capture/);
  });
});
