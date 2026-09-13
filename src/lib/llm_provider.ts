import * as openai from '@livekit/agents-plugin-openai';
import { inference, type llm } from '@livekit/agents';

export type CaraLlmProviderKind = 'gateway' | 'openai-direct';

export type CreateCaraLlmInput = {
  inferenceLlmModel: string;
  profileLlmProvider?: string | null;
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

/** gpt-5-mini burns completion budget on reasoning — 120 tokens often yields empty speech. */
const DEFAULT_VOICE_MAX_COMPLETION_TOKENS = 320;

function parseOptionalPenalty(envKey: string): number {
  const parsed = Number.parseFloat(process.env[envKey] ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function voiceMaxCompletionTokens(fallback = DEFAULT_VOICE_MAX_COMPLETION_TOKENS): number {
  const parsed = Number.parseInt(process.env.LIVEKIT_LLM_MAX_TOKENS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envProvider(): string {
  return process.env.CARA_LLM_PROVIDER?.trim().toLowerCase() || '';
}

export function resolveCaraLlmProvider(input?: {
  profileLlmProvider?: string | null | undefined;
}): CaraLlmProviderKind {
  const profile = input?.profileLlmProvider?.trim().toLowerCase();
  if (profile === 'gateway' || profile === 'openai-direct') {
    return profile;
  }

  const configured = envProvider();
  if (configured === 'openai-direct' || configured === 'gateway' || configured === 'openai') {
    if (configured === 'openai-direct' || (configured === 'openai' && process.env.OPENAI_API_KEY?.trim())) {
      return 'openai-direct';
    }
    return 'gateway';
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
  });

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
