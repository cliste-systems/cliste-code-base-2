import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bufferCartesiaStreamBySentence,
  bufferTtsStreamBySentence,
  buildTtsNodeInputStream,
  prepareCartesiaSpeechChunk,
  prepareCartesiaGreetingChunk,
  prepareGreetingForTts,
  prepareHardcodedSpeechForTts,
  setActiveTtsModelForSanitizer,
} from './tts_text_sanitize.js';

const RETAIL_GREETING =
  "Thanks for calling Kavanaghs SuperValu. I'm Cara, the AI assistant. This call may be recorded and transcribed. How can I help you?";

describe('tts_text_sanitize', () => {
  it('flows retail greeting clauses with commas', () => {
    const out = prepareGreetingForTts(RETAIL_GREETING);
    assert.match(out, /Thanks for calling Kavanahs SuperValu,/);
    assert.match(out, /how can I help you\?/);
  });

  it('softens goodbye for TTS', () => {
    const out = prepareHardcodedSpeechForTts('Thanks for calling, Brandon. Goodbye!');
    assert.match(out, /take care/i);
    assert.doesNotMatch(out, /Goodbye!/i);
    assert.doesNotMatch(out, /\bbye\b/i);
  });

  it('strips model control tokens before TTS', () => {
    const out = prepareHardcodedSpeechForTts('No bother — take care. <|end|>');
    assert.doesNotMatch(out, /<\|/);
    assert.match(out, /take care/i);
  });

  it('maps is that alright to okay for TTS', () => {
    const out = prepareHardcodedSpeechForTts('I can text you our directions link — is that alright?');
    assert.match(out, /is that okay/i);
    assert.doesNotMatch(out, /alright/i);
  });

  it('speaks clock times naturally for Irish phone TTS', () => {
    const out = prepareHardcodedSpeechForTts(
      'We open at 8:00 am on Thursdays and close at 21:00.',
    );
    assert.match(out, /eight o'clock in the morning/i);
    assert.match(out, /nine o'clock in the evening/i);
    assert.doesNotMatch(out, /8:00/);
    assert.doesNotMatch(out, /21:00/);
  });

  it('respells garage for Irish TTS', () => {
    const out = prepareHardcodedSpeechForTts('We run a garage in Donegal.');
    assert.match(out, /gar-idge/i);
    assert.doesNotMatch(out, /\bgarage\b/i);
  });

  it('maps Cara to Irish Kara for TTS', () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3.6');
    const out = prepareHardcodedSpeechForTts("Hello, you're through to Cara.");
    assert.match(out, /Kara/);
    assert.doesNotMatch(out, /\bCara\b/);
  });

  it('flushes unpunctuated short replies through sentence buffer', async () => {
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('Lovely — happy to help');
        controller.close();
      },
    });
    const reader = bufferTtsStreamBySentence(source).getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    assert.ok(chunks.join(' ').includes('Lovely'));
  });

  it('buffers Cartesia stream by sentence with SSML breaks', async () => {
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('We are open today. Anything else?');
        controller.close();
      },
    });
    const reader = bufferCartesiaStreamBySentence(source).getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    assert.ok(chunks.some((c) => c.includes('<break')));
  });

  it('prepareCartesiaGreetingChunk keeps intro brisk', () => {
    const greeting =
      "Hello, you're through to Cara. I'm the AI assistant. This call may be recorded. How can I help you today?";
    const out = prepareCartesiaGreetingChunk(greeting);
    assert.match(out, /<break time="160ms"\/>/);
  });

  it('cartesia greeting single-utterance does not double-prepare', async () => {
    const greeting =
      "Hello, you're through to Cara. I'm the AI assistant. This call may be recorded. How can I help you today?";
    const prepared = prepareHardcodedSpeechForTts(greeting, {
      greeting: true,
      greetingCommaFlow: false,
      greetingRetailOpening: true,
    });
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(prepared);
        controller.close();
      },
    });
    const reader = buildTtsNodeInputStream(source, { singleUtterance: true }).getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], prepared);
  });
});
