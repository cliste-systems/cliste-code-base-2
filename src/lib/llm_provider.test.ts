import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveCaraLlmProvider } from './llm_provider.js';

describe('resolveCaraLlmProvider', () => {
  it('prefers openrouter when key is set and no explicit provider', () => {
    const prevProvider = process.env.CARA_LLM_PROVIDER;
    const prevKey = process.env.OPENROUTER_API_KEY;
    delete process.env.CARA_LLM_PROVIDER;
    delete process.env.SALON_LLM_PROVIDER;
    process.env.OPENROUTER_API_KEY = 'test-key';
    try {
      assert.equal(resolveCaraLlmProvider(), 'openrouter');
    } finally {
      if (prevProvider === undefined) delete process.env.CARA_LLM_PROVIDER;
      else process.env.CARA_LLM_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    }
  });

  it('honours CARA_LLM_PROVIDER=gateway', () => {
    const prevProvider = process.env.CARA_LLM_PROVIDER;
    const prevKey = process.env.OPENROUTER_API_KEY;
    process.env.CARA_LLM_PROVIDER = 'gateway';
    process.env.OPENROUTER_API_KEY = 'test-key';
    try {
      assert.equal(resolveCaraLlmProvider(), 'gateway');
    } finally {
      if (prevProvider === undefined) delete process.env.CARA_LLM_PROVIDER;
      else process.env.CARA_LLM_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    }
  });

  it('forces gateway on demo line even when OpenRouter is configured', () => {
    const prevKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    try {
      assert.equal(resolveCaraLlmProvider({ forceGateway: true }), 'gateway');
    } finally {
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    }
  });
});
