import * as openai from '@livekit/agents-plugin-openai';
import { inference, type llm } from '@livekit/agents';
import OpenAI from 'openai';

export type CaraLlmProviderKind = 'gateway' | 'openai-direct' | 'openrouter';

export type CreateCaraLlmInput = {
  inferenceLlmModel: string;
  profileLlmProvider?: string | null;
  /** Demo/test line — use LiveKit Inference gateway even when OpenRouter is configured. */
  forceGateway?: boolean;
  reasoningEffort?: ChatCompletionOptions['reasoning_effort'];
  temperature?: number;
  maxCompletionTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
};

type ChatCompletionOptions = {
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
};

export type ResolvedCaraLlm = {
  provider: CaraLlmProviderKind;
  label: string;
  instance: llm.LLM;
};

const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5-mini';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** gpt-5-mini burns completion budget on reasoning — 120 tokens often yields empty speech. */
const DEFAULT_VOICE_MAX_COMPLETION_TOKENS = 320;
const GPT5_MIN_VOICE_COMPLETION_TOKENS = 320;

function parseOptionalPenalty(envKey: string): number {
  const parsed = Number.parseFloat(process.env[envKey] ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function voiceMaxCompletionTokens(fallback = DEFAULT_VOICE_MAX_COMPLETION_TOKENS): number {
  const parsed = Number.parseInt(process.env.LIVEKIT_LLM_MAX_TOKENS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reasoning-mandatory on OpenRouter — needs effort=minimal, not enabled=false. */
function openRouterNeedsMinimalReasoning(model: string): boolean {
  const m = model.trim().toLowerCase();
  return (
    /^openai\/gpt-5(?:$|-mini|-nano|-pro)/.test(m) ||
    /^gpt-5(?:$|-mini|-nano|-pro)/.test(m)
  );
}

function createOpenRouterFetch(): typeof fetch {
  const baseFetch = globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    if (!init?.body || typeof init.body !== 'string') {
      return baseFetch(input, init);
    }
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const model = String(body.model ?? '');
      if (openRouterNeedsMinimalReasoning(model)) {
        body.reasoning = { effort: 'minimal' };
        const cap = Math.max(voiceMaxCompletionTokens(), GPT5_MIN_VOICE_COMPLETION_TOKENS);
        const current = body.max_completion_tokens;
        if (typeof current !== 'number' || current < cap) {
          body.max_completion_tokens = cap;
        }
      }
      return baseFetch(input, { ...init, body: JSON.stringify(body) });
    } catch {
      return baseFetch(input, init);
    }
  };
}

function envProvider(): string {
  return (
    process.env.CARA_LLM_PROVIDER?.trim().toLowerCase() ||
    process.env.SALON_LLM_PROVIDER?.trim().toLowerCase() ||
    ''
  );
}

function openRouterApiKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key || null;
}

function openRouterBaseUrl(): string {
  return (
    process.env.OPENROUTER_API_BASE_URL?.trim().replace(/\/$/, '') ||
    DEFAULT_OPENROUTER_BASE_URL
  );
}

function openRouterModel(inferenceLlmModel: string): string {
  const explicit =
    process.env.OPENROUTER_MODEL?.trim() ||
    process.env.CARA_OPENROUTER_MODEL?.trim();
  if (explicit) return explicit;

  const fromInference = inferenceLlmModel.trim();
  if (fromInference.includes('/')) return fromInference;

  const bare = fromInference.replace(/^openai\//, '');
  return `openai/${bare || 'gpt-5-mini'}`;
}

function openRouterClient(): OpenAI {
  const apiKey = openRouterApiKey();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required for OpenRouter LLM');
  }

  const referer =
    process.env.OPENROUTER_HTTP_REFERER?.trim() ||
    process.env.CLISTE_APP_URL?.trim() ||
    'https://hellocara.ie';
  const title = process.env.OPENROUTER_APP_TITLE?.trim() || 'Cliste Cara Voice';

  return new OpenAI({
    baseURL: openRouterBaseUrl(),
    apiKey,
    fetch: createOpenRouterFetch(),
    defaultHeaders: {
      'HTTP-Referer': referer,
      'X-Title': title,
    },
  });
}

export function resolveCaraLlmProvider(input?: {
  profileLlmProvider?: string | null | undefined;
  forceGateway?: boolean;
}): CaraLlmProviderKind {
  if (input?.forceGateway) return 'gateway';

  const profile = input?.profileLlmProvider?.trim().toLowerCase();
  if (profile === 'openrouter' || profile === 'gateway' || profile === 'openai-direct') {
    return profile;
  }

  const configured = envProvider();
  if (configured === 'openrouter' || configured === 'openai-direct' || configured === 'gateway') {
    return configured;
  }

  if (openRouterApiKey()) return 'openrouter';
  if (configured === 'openai' && process.env.OPENAI_API_KEY?.trim()) {
    return 'openai-direct';
  }

  return 'gateway';
}

export function createCaraLlm(input: CreateCaraLlmInput): ResolvedCaraLlm {
  const temperature = input.temperature ?? 0.7;
  const maxCompletionTokens = input.maxCompletionTokens ?? voiceMaxCompletionTokens();
  const frequencyPenalty =
    input.frequencyPenalty ?? parseOptionalPenalty('LIVEKIT_LLM_FREQUENCY_PENALTY');
  const presencePenalty =
    input.presencePenalty ?? parseOptionalPenalty('LIVEKIT_LLM_PRESENCE_PENALTY');
  const provider = resolveCaraLlmProvider({
    profileLlmProvider: input.profileLlmProvider,
    forceGateway: input.forceGateway,
  });

  if (provider === 'openrouter') {
    const model = openRouterModel(input.inferenceLlmModel);
    const instance = new openai.LLM({
      client: openRouterClient(),
      model,
      temperature,
      maxCompletionTokens,
    });
    return { provider, label: `openrouter:${model}`, instance };
  }

  if (provider === 'openai-direct') {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      console.warn('[llm] openai-direct requested but OPENAI_API_KEY missing — falling back to gateway');
      return createGatewayLlm(
        input.inferenceLlmModel,
        temperature,
        maxCompletionTokens,
        frequencyPenalty,
        presencePenalty,
      );
    }
    const model = input.inferenceLlmModel.replace(/^openai\//, '');
    const instance = new openai.LLM({
      apiKey,
      model,
      temperature,
      maxCompletionTokens,
    });
    return { provider: 'openai-direct', label: `openai-direct:${model}`, instance };
  }

  return createGatewayLlm(
    input.inferenceLlmModel,
    temperature,
    maxCompletionTokens,
    frequencyPenalty,
    presencePenalty,
    input.reasoningEffort,
  );
}

function createGatewayLlm(
  inferenceLlmModel: string,
  temperature: number,
  maxCompletionTokens: number,
  frequencyPenalty = 0,
  presencePenalty = 0,
  reasoningEffort?: ChatCompletionOptions['reasoning_effort'],
): ResolvedCaraLlm {
  const instance = new inference.LLM({
    model: inferenceLlmModel as inference.LLMModels,
    modelOptions: {
      temperature,
      max_completion_tokens: maxCompletionTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(frequencyPenalty !== 0 ? { frequency_penalty: frequencyPenalty } : {}),
      ...(presencePenalty !== 0 ? { presence_penalty: presencePenalty } : {}),
    },
  });
  return {
    provider: 'gateway',
    label: inferenceLlmModel,
    instance,
  };
}
