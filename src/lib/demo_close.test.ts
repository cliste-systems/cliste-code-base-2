import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  callerSoundsLikeImminentClose,
  drainReadableStream,
  emptyTextStream,
  shouldArmDemoCloseFromCallerText,
  shouldDropLlmTtsWhileClosing,
} from './demo_close.js';
import { assistantTextSoundsLikeGoodbye } from './end_call.js';

describe('demo_close', () => {
  it('detects imminent close on interim wind-down phrases', () => {
    assert.equal(callerSoundsLikeImminentClose("No, that's everything"), true);
    assert.equal(callerSoundsLikeImminentClose("Yeah that's all thanks"), true);
    assert.equal(callerSoundsLikeImminentClose("that's every"), true);
    assert.equal(callerSoundsLikeImminentClose('Can you repeat that?'), false);
    assert.equal(callerSoundsLikeImminentClose('I own a garage'), false);
  });

  it('arms demo close from final caller text', () => {
    assert.equal(
      shouldArmDemoCloseFromCallerText("No, that's everything", {}, { interim: false }),
      true,
    );
    assert.equal(
      shouldArmDemoCloseFromCallerText("Yeah, that's fine", {}, { interim: false }),
      false,
    );
    assert.equal(
      shouldArmDemoCloseFromCallerText("Yeah that's all thanks", {}, { interim: true }),
      true,
    );
    assert.equal(
      shouldArmDemoCloseFromCallerText('I have a salon', {}, { interim: true }),
      false,
    );
  });

  it('drops LLM TTS when closing unless prepared programmatic speech', () => {
    assert.equal(
      shouldDropLlmTtsWhileClosing({
        closingCall: true,
        preparedSpeechSingleUtteranceNext: false,
        singleUtteranceTtsNext: false,
      }),
      true,
    );
    assert.equal(
      shouldDropLlmTtsWhileClosing({
        closingCall: true,
        preparedSpeechSingleUtteranceNext: true,
        singleUtteranceTtsNext: false,
      }),
      false,
    );
    assert.equal(
      shouldDropLlmTtsWhileClosing({
        closingCall: true,
        preparedSpeechSingleUtteranceNext: false,
        singleUtteranceTtsNext: true,
      }),
      false,
    );
    assert.equal(
      shouldDropLlmTtsWhileClosing({
        closingCall: false,
        preparedSpeechSingleUtteranceNext: false,
        singleUtteranceTtsNext: false,
      }),
      false,
    );
  });

  it('allows LLM TTS after goodbye-shaped text when closingCall is not set prematurely', () => {
    assert.equal(assistantTextSoundsLikeGoodbye('Thank you! Have a great day!'), true);
    assert.equal(
      shouldDropLlmTtsWhileClosing({
        closingCall: false,
        preparedSpeechSingleUtteranceNext: false,
        singleUtteranceTtsNext: false,
      }),
      false,
    );
  });

  it('drains readable streams for dropped LLM TTS', async () => {
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('Lovely — how are you keeping?');
        controller.close();
      },
    });
    await drainReadableStream(source);
    const reader = source.getReader();
    const { done } = await reader.read();
    assert.equal(done, true);
  });

  it('emptyTextStream closes immediately', async () => {
    const reader = emptyTextStream().getReader();
    const { done, value } = await reader.read();
    assert.equal(done, true);
    assert.equal(value, undefined);
  });
});
