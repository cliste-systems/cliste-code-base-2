import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bufferTtsStreamBySentence,
  bufferTtsStreamForCartesia,
  buildTtsNodeInputStream,
  prepareCartesiaSpeechChunk,
  prepareCartesiaGreetingChunk,
  prepareGreetingForTts,
  prepareHardcodedSpeechForTts,
  prepareTextForTtsStreaming,
  setActiveTtsModelForSanitizer,
} from './tts_text_sanitize.js';

const BLOOM_GREETING =
  "Thanks for calling Bloom Beauty Studio. I'm Cara, the AI assistant. This call may be recorded and transcribed. How can I help you?";

describe('tts_text_sanitize', () => {
  it('flows Bloom greeting clauses with commas', () => {
    const out = prepareGreetingForTts(BLOOM_GREETING);
    assert.match(out, /Thanks for calling Bloom Beauty Studio,/);
    assert.match(out, /how can I help you\?/);
    assert.doesNotMatch(out, /Studio\. I'm/);
  });

  it('softens goodbye for TTS', () => {
    const out = prepareHardcodedSpeechForTts('Thanks for calling, Brandon. Goodbye!');
    assert.match(out, /take care/i);
    assert.doesNotMatch(out, /Goodbye!/i);
    assert.doesNotMatch(out, /\bbye\b/i);
  });

  it('softens bare bye at end of line', () => {
    const out = prepareHardcodedSpeechForTts('Lovely — thanks for calling. Bye.');
    assert.match(out, /take care/i);
    assert.doesNotMatch(out, /\bbye\b/i);
  });

  it('strips model control tokens before TTS', () => {
    const out = prepareHardcodedSpeechForTts('No bother — take care. <|end|>');
    assert.doesNotMatch(out, /<\|/);
    assert.match(out, /take care/i);
  });

  it('strips emoji before TTS', () => {
    const out = prepareHardcodedSpeechForTts('Grand, Abigail — take care now. 👋');
    assert.doesNotMatch(out, /👋/);
    assert.match(out, /take care/i);
  });

  it('inserts comma after leading acknowledgement before a name', () => {
    const out = prepareHardcodedSpeechForTts('No bother Abigail — take care now.');
    assert.match(out, /^No bother, Abigail/i);
  });

  it('maps is that alright to okay for TTS (avoids drawn-out alright)', () => {
    const out = prepareHardcodedSpeechForTts(
      "I can text you our booking link — is that alright?",
    );
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

  it('collapses repeated letters that turbo screams', () => {
    const out = prepareHardcodedSpeechForTts('Hellooooo — grand so.');
    assert.match(out, /Hello — lovely so/);
    assert.doesNotMatch(out, /Hellooooo/);
    assert.doesNotMatch(out, /\bgrand\b/i);
  });

  it('applies pronunciation replacements', () => {
    const out = prepareHardcodedSpeechForTts('Book on Fresha.');
    assert.match(out, /Fresh-ah/i);
  });

  it('respells garage and salon for Irish TTS', () => {
    const out = prepareHardcodedSpeechForTts('We run a garage and a salon.');
    assert.match(out, /gar-idge/i);
    assert.match(out, /sal-on/i);
    assert.doesNotMatch(out, /\bgarage\b/i);
    assert.doesNotMatch(out, /\bsalon\b/i);
  });

  it('maps Cara to Irish Kara for TTS', () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3');
    const out = prepareHardcodedSpeechForTts("Hello, you're through to Cara.");
    assert.match(out, /Kara/);
    assert.doesNotMatch(out, /\bCara\b/);
  });

  it('strips v3 audio tags when model is turbo', () => {
    setActiveTtsModelForSanitizer('eleven_turbo_v2_5');
    const out = prepareHardcodedSpeechForTts('Grand — [pause] lovely.');
    assert.doesNotMatch(out, /\[pause\]/);
    assert.match(out, /lovely — lovely/);
  });

  it('keeps v3 audio tags when model is v3', () => {
    setActiveTtsModelForSanitizer('eleven_v3');
    const out = prepareHardcodedSpeechForTts('Grand — [pause] lovely.');
    assert.match(out, /\[pause\]/);
    setActiveTtsModelForSanitizer('eleven_turbo_v2_5');
  });

  it('flushes unpunctuated short replies through sentence buffer', async () => {
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('Lovely — happy to help');
        controller.close();
      },
    });
    const reader = bufferTtsStreamBySentence(source).getReader();
    const { value, done } = await reader.read();
    assert.equal(done, false);
    assert.match(value ?? '', /Lovely — happy to help/);
    const next = await reader.read();
    assert.equal(next.done, true);
  });

  it('prepareCartesiaSpeechChunk uses SSML breaks instead of periods', () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3');
    const out = prepareCartesiaSpeechChunk(
      "Yeah, I can hear you fine. What would you like to try?",
    );
    assert.match(out, /Yeah, I can hear you fine/);
    assert.match(out, /<break time="240ms"\/> What would you like to try\?/);
    assert.doesNotMatch(out, /\./);
    assert.doesNotMatch(out, /<break time="160ms"\/>/);
  });

  it('prepareCartesiaSpeechChunk pauses before comma-run-on questions', () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3.5');
    const out = prepareCartesiaSpeechChunk(
      "It's a beautiful day, what kind of business have you got Joe?",
    );
    assert.match(out, /It's a beautiful day/);
    assert.match(out, /<break time="240ms"\/> what kind of business have you got Joe\?/);
    assert.doesNotMatch(out, /beautiful day, what/);
  });

  it('prepareCartesiaSpeechChunk slows farewell outro with outro breaks', () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3.5');
    const out = prepareCartesiaSpeechChunk(
      'Perfect, Martin — thanks for calling Hello Cara today. Have a good day. Bye for now.',
    );
    assert.match(out, /Perfect, Martin <break time="400ms"\/> thanks for calling/i);
    assert.match(out, /<break time="400ms"\/> Have a good day/);
    assert.match(out, /<break time="400ms"\/> Bye for now/);
    assert.doesNotMatch(out, /<break time="240ms"\/>/);
  });

  it('prepareCartesiaSpeechChunk keeps mid-call dashes flowing without outro breaks', () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3.5');
    const out = prepareCartesiaSpeechChunk(
      'Sure — I can help an electrician by answering calls, taking messages, and sending out appointment reminders. What would you like to try?',
    );
    assert.match(out, /Sure — I can help an electrician by answering calls, taking messages/);
    assert.match(out, /<break time="240ms"\/> What would you like to try\?/);
    assert.doesNotMatch(out, /<break time="160ms"\/>/);
    assert.doesNotMatch(out, /<break time="320ms"\/>/);
  });

  it('strips bracketed fake tool annotations before TTS', () => {
    const out = prepareHardcodedSpeechForTts(
      'Lovely, Martin — thanks for calling Hello Cara today. Have a good day. Bye for now. [tool call] Might need actually invoke tool, not textual.',
    );
    assert.doesNotMatch(out, /\[tool call\]/i);
    assert.doesNotMatch(out, /invoke tool/i);
    assert.match(out, /Bye for now/i);
  });

  it('cartesia buffer streams sentence chunks without trailing periods', async () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3');
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('Yeah, I can hear you fine. ');
        controller.enqueue('What would you like to try?');
        controller.close();
      },
    });
    const reader = bufferTtsStreamForCartesia(source).getReader();
    const chunks: string[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    assert.ok(chunks.length >= 1);
    assert.match(chunks.join(' '), /Yeah, I can hear you fine/);
    assert.match(chunks.join(' '), /What would you like to try/);
    assert.doesNotMatch(chunks.join(' '), /\./);
  });

  it('cartesia multi-sentence replies pause between streamed chunks', async () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3.5');
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(
          'Hello! I can take a message for the electrician and let them know you need assistance. What issue are you experiencing?',
        );
        controller.close();
      },
    });
    const reader = buildTtsNodeInputStream(source, { provider: 'cartesia-inference' }).getReader();
    const chunks: string[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    assert.equal(chunks.length, 2);
    assert.match(chunks[0]!, /need assistance/);
    assert.match(chunks[1]!, /^<break time="240ms"\/> What issue are you experiencing\?/);
  });

  it('cartesia streamed outro uses slower farewell breaks between sentences', async () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3.5');
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(
          'Perfect, Martin — thanks for calling Hello Cara today. Have a good day. Bye for now.',
        );
        controller.close();
      },
    });
    const reader = bufferTtsStreamForCartesia(source).getReader();
    const chunks: string[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const joined = chunks.join(' ');
    assert.ok(chunks.length >= 1);
    assert.match(joined, /thanks for calling Hello Kara today/);
    assert.match(joined, /<break time="400ms"\/> Have a good day/);
    assert.match(joined, /<break time="400ms"\/> Bye for now/);
    assert.doesNotMatch(joined, /<break time="240ms"\/>/);
  });

  it('buildTtsNodeInputStream routes cartesia by sentence for faster first audio', async () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3');
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('One clause. Two clause.');
        controller.close();
      },
    });
    const reader = buildTtsNodeInputStream(source, {
      provider: 'cartesia-inference',
    }).getReader();
    const chunks: string[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    assert.ok(chunks.length >= 1);
    assert.match(chunks.join(' '), /One clause/);
    assert.match(chunks.join(' '), /Two clause/);
    assert.match(chunks.join(' '), /<break time="240ms"\/>/);
    assert.doesNotMatch(chunks.join(' '), /\./);
  });

  it('respells Donegal for Irish TTS', () => {
    const out = prepareHardcodedSpeechForTts('Kavanaghs SuperValu Donegal Town.');
    assert.match(out, /Doneigall/i);
    assert.doesNotMatch(out, /\bDonegal\b/i);
    assert.doesNotMatch(out, /Dun-ih-gall/i);
  });

  it('prepareCartesiaRetailOpeningChunk keeps retail intro natural', () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3.5');
    const greeting =
      "Hello, you're through to Kavanaghs SuperValu Doneigall Town. I'm Cara, the AI assistant. This call may be recorded and transcribed. How can I help you today?";
    const out = prepareHardcodedSpeechForTts(greeting, {
      greeting: true,
      greetingCommaFlow: false,
      greetingRetailOpening: true,
    });
    assert.match(out, /Hello, you're through to Kavanaghs SuperValu Doneigall Town<break time="240ms"\/> I'm Kara, the AI assistant/);
    assert.match(out, /<break time="240ms"\/> This call may be recorded and transcribed/);
    assert.match(out, /<break time="240ms"\/> How can I help you today\?/);
    assert.doesNotMatch(out, /<break time="480ms"\/>/);
  });

  it('prepareCartesiaGreetingChunk keeps intro brisk — sentence breaks only', () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3.5');
    const greeting =
      "Hi — you're through to Hello Cara. I'm your AI assistant, and this call may be recorded and transcribed. How are you keeping today?";
    const out = prepareCartesiaGreetingChunk(greeting);
    assert.match(out, /Hello Kara<break time="160ms"\/> I'm your AI assistant, and this call may be recorded and transcribed/);
    assert.match(out, /<break time="160ms"\/> How are you keeping today\?/);
    assert.doesNotMatch(out, /<break time="240ms"\/>/);
    assert.doesNotMatch(out, /<break time="320ms"\/>/);
    assert.doesNotMatch(out, /Hello Cara.*Hello Cara/);
  });
  it('cartesia greeting single-utterance does not replay or double-prepare the opening', async () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3.5');
    const greeting =
      "Hi — you're through to Hello Cara. I'm your AI assistant, and this call may be recorded and transcribed. How are you keeping today?";
    const prepared = prepareHardcodedSpeechForTts(greeting, {
      greeting: true,
      greetingCommaFlow: false,
    });
    const breakCount = (prepared.match(/<break /g) ?? []).length;
    assert.equal(breakCount, 2);
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(prepared);
        controller.close();
      },
    });
    const reader = buildTtsNodeInputStream(source, {
      provider: 'cartesia-inference',
      singleUtterance: true,
    }).getReader();
    const chunks: string[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], prepared);
    assert.doesNotMatch(chunks[0]!, /Hello Cara.*Hello Cara/);
  });

  it('cartesia comma early-flush does not repeat flushed prefix in later chunks', async () => {
    setActiveTtsModelForSanitizer('cartesia/sonic-3.5');
    const prepared = prepareCartesiaSpeechChunk(
      "You're through to Hello Cara, the demo line — I'm Cara, the AI assistant, This call may be recorded and transcribed, What would you like to try",
    );
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(prepared);
        controller.close();
      },
    });
    const reader = buildTtsNodeInputStream(source, {
      provider: 'cartesia-inference',
    }).getReader();
    const chunks: string[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    assert.ok(chunks.length >= 1);
    const joined = chunks.join(' ');
    assert.doesNotMatch(joined, /Hello Cara,\s+You're through to Hello Cara/);
    if (chunks.length > 1) {
      assert.doesNotMatch(chunks[1]!, /^You're through to Hello Cara,/);
    }
  });
});
