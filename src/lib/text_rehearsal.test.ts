import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assistantReplyLooksLikeRetailFulfilmentClarification,
  assistantTextQuotesPrices,
  buildTextRehearsalDispatchMetadata,
  encodeTextRehearsalPacket,
  evaluateTextRehearsalExpectations,
  isTextRehearsalEnabled,
  isTextRehearsalSession,
  parseTextRehearsalPacket,
  waitForTextRehearsalTurnReply,
} from './text_rehearsal.js';

describe('text_rehearsal', () => {
  it('requires env flag in production', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevFlag = process.env.CARA_TEXT_REHEARSAL;
    process.env.NODE_ENV = 'production';
    process.env.CARA_TEXT_REHEARSAL = '1';
    assert.equal(isTextRehearsalEnabled(), true);
    assert.equal(isTextRehearsalSession({ roomName: 'text-rehearsal-abc' }), true);
    process.env.CARA_TEXT_REHEARSAL = '';
    assert.equal(isTextRehearsalSession({ roomName: 'text-rehearsal-abc' }), false);
    process.env.NODE_ENV = prevNodeEnv;
    process.env.CARA_TEXT_REHEARSAL = prevFlag;
  });

  it('detects text rehearsal rooms in dev without env flag', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevFlag = process.env.CARA_TEXT_REHEARSAL;
    process.env.NODE_ENV = 'development';
    delete process.env.CARA_TEXT_REHEARSAL;
    assert.equal(
      isTextRehearsalSession({ roomName: 'text-rehearsal-abc' }),
      true,
    );
    assert.equal(
      isTextRehearsalSession({
        jobMetadata: buildTextRehearsalDispatchMetadata({
          calledNumber: '+353749759508',
        }),
      }),
      true,
    );
    process.env.NODE_ENV = prevNodeEnv;
    process.env.CARA_TEXT_REHEARSAL = prevFlag;
  });

  it('round-trips packets', () => {
    const packet = { type: 'caller_turn', text: 'hello', turnId: 't1' } as const;
    const parsed = parseTextRehearsalPacket(encodeTextRehearsalPacket(packet));
    assert.deepEqual(parsed, packet);
  });

  it('flags retail clarification and prices', () => {
    assert.equal(
      assistantReplyLooksLikeRetailFulfilmentClarification(
        'Do you mean fresh at the butcher counter, priced per kilo, or the pre-pack packs in the meat aisle?',
      ),
      true,
    );
    assert.equal(assistantTextQuotesPrices('Denny sausages are €3.50 this week.'), true);
    assert.equal(assistantTextQuotesPrices('I can check that for you at the counter.'), false);
  });

  it('waits for new assistant text even when agent is already listening', async () => {
    let assistant = '';
    let listening = false;
    let done = false;
    const callbacks: Array<() => void> = [];
    const handle = {
      done: () => done,
      addDoneCallback: (cb: () => void) => {
        callbacks.push(cb);
      },
    };

    const wait = waitForTextRehearsalTurnReply({
      handle,
      getAssistantText: () => assistant,
      isAgentListening: () => listening,
      timeoutMs: 1000,
    });

    listening = true;
    await new Promise((resolve) => setTimeout(resolve, 80));

    let resolved = false;
    void wait.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(resolved, false);

    assistant = 'At the butcher counter this week...';
    done = true;
    for (const cb of callbacks) cb();
    await wait;
    assert.equal(resolved, true);
  });

  it('evaluates scenario expectations', () => {
    const failures = evaluateTextRehearsalExpectations({
      assistantLines: [
        'Do you mean fresh at the butcher counter, priced per kilo, or the pre-pack packs in the meat aisle?',
      ],
      toolCalls: [{ name: 'searchSuperValuProducts', args: { query: 'steaks on offer', intent: 'offer' } }],
      expect: { clarification: true, must_not_quote_prices: true },
    });
    assert.deepEqual(failures, []);
  });
});
