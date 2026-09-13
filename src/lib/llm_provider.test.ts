import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveCaraLlmProvider } from './llm_provider.js';

describe('llm_provider', () => {
  it('defaults to gateway when no explicit provider', () => {
    const prev = process.env.CARA_LLM_PROVIDER;
    delete process.env.CARA_LLM_PROVIDER;
    try {
      assert.equal(resolveCaraLlmProvider(), 'gateway');
    } finally {
      if (prev === undefined) delete process.env.CARA_LLM_PROVIDER;
      else process.env.CARA_LLM_PROVIDER = prev;
    }
  });

  it('honours CARA_LLM_PROVIDER=openai-direct when OpenAI key is set', () => {
    const prevProvider = process.env.CARA_LLM_PROVIDER;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.CARA_LLM_PROVIDER = 'openai-direct';
    process.env.OPENAI_API_KEY = 'test-key';
    try {
      assert.equal(resolveCaraLlmProvider(), 'openai-direct');
    } finally {
      if (prevProvider === undefined) delete process.env.CARA_LLM_PROVIDER;
      else process.env.CARA_LLM_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
  });
});
