import { inference, stt } from '@livekit/agents';

import {
  buildAssemblyAiSttOptions,
  isAssemblyAiSttModel,
  type AssemblyAiSttOptions,
} from './stt_keyterms.js';

export const STT_RECOVERY_SPEECH_LINE =
  "Sorry — I'm having a brief technical hitch. Bear with me one moment.";

export const STT_FAILURE_AI_SUMMARY =
  'Call dropped — STT rate limit or connection failure. Caller may have heard partial greeting only.';

export type BuildResilientInferenceSttInput = {
  primaryModel: string;
  fallbackModel: string | null;
  language: string;
  primaryOptions: AssemblyAiSttOptions | Record<string, unknown>;
  fallbackKeyterms?: string[];
  fallbackDomainPrompt?: string;
  fallbackMinTurnSilenceMs?: number;
  fallbackMaxTurnSilenceMs?: number;
  fallbackEotConfidence?: number;
};

/** Production fallback when primary is u3-rt-pro — not used on Hello Cara demo stack. */
export function resolveInferenceSttFallbackModel(
  primaryModel: string,
  demoExperienceStack: boolean,
): string | null {
  if (demoExperienceStack) return null;
  const fromEnv = process.env.LIVEKIT_INFERENCE_STT_FALLBACK_MODEL?.trim();
  if (fromEnv) return fromEnv;
  if (primaryModel.toLowerCase().includes('u3-rt-pro')) {
    return 'assemblyai/universal-streaming';
  }
  return null;
}

export function isSttRateLimitOrTransientError(message: string, err?: unknown): boolean {
  const haystack = `${message} ${formatUnknownError(err)}`.toLowerCase();
  if (/\b429\b/.test(haystack)) return true;
  if (/\b503\b/.test(haystack)) return true;
  if (haystack.includes('rate limit')) return true;
  if (haystack.includes('too many requests')) return true;
  if (haystack.includes('unexpected server response: 429')) return true;
  return false;
}

export function classifySttPipelineError(message: string, err?: unknown): {
  retryable: boolean;
  statusCode?: number;
} {
  const haystack = `${message} ${formatUnknownError(err)}`;
  const statusMatch = haystack.match(/\bstatusCode["']?\s*[:=]\s*(\d{3})\b/i)
    ?? haystack.match(/unexpected server response:\s*(\d{3})/i)
    ?? haystack.match(/\b(\d{3})\b/);
  const statusCode = statusMatch ? Number.parseInt(statusMatch[1]!, 10) : undefined;
  const retryable =
    statusCode === 429 ||
    statusCode === 503 ||
    statusCode === 502 ||
    isSttRateLimitOrTransientError(message, err);
  if (statusCode !== undefined) {
    return { retryable, statusCode };
  }
  return { retryable };
}

export function resolveCallOutcomeWithSttFailure(input: {
  transcriptLineCount: number;
  sttFailureDetected: boolean;
}): { outcome: string; aiSummary: string } | null {
  if (input.sttFailureDetected && input.transcriptLineCount === 0) {
    return { outcome: 'stt_failure', aiSummary: STT_FAILURE_AI_SUMMARY };
  }
  return null;
}

function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return '';
}

function createInferenceStt(
  model: string,
  language: string,
  modelOptions: AssemblyAiSttOptions | Record<string, unknown>,
): inference.STT {
  return new inference.STT({
    model,
    language,
    modelOptions,
  });
}

function fallbackAdapterOptions(): Pick<
  stt.FallbackAdapterOptions,
  'maxRetryPerSTT' | 'retryIntervalMs' | 'attemptTimeoutMs'
> {
  return {
    maxRetryPerSTT: Number.parseInt(process.env.LIVEKIT_STT_MAX_RETRY_PER_INSTANCE ?? '2', 10) || 2,
    retryIntervalMs: Number.parseInt(process.env.LIVEKIT_STT_RETRY_INTERVAL_MS ?? '2000', 10) || 2000,
    attemptTimeoutMs: Number.parseInt(process.env.LIVEKIT_STT_ATTEMPT_TIMEOUT_MS ?? '10000', 10) || 10000,
  };
}

/** Primary + optional fallback STT — masks transient 429/503 from killing the session. */
export function buildResilientInferenceStt(input: BuildResilientInferenceSttInput) {
  const primary = createInferenceStt(input.primaryModel, input.language, input.primaryOptions);
  const fallbackModel = input.fallbackModel?.trim();
  if (!fallbackModel || fallbackModel === input.primaryModel) {
    return primary;
  }

  const fallbackOptions = isAssemblyAiSttModel(fallbackModel)
    ? buildAssemblyAiSttOptions({
        model: fallbackModel,
        keyterms: input.fallbackKeyterms ?? [],
        domainPrompt: input.fallbackDomainPrompt ?? '',
        minTurnSilenceMs: input.fallbackMinTurnSilenceMs ?? 200,
        maxTurnSilenceMs: input.fallbackMaxTurnSilenceMs ?? 1000,
        eotConfidence: input.fallbackEotConfidence ?? 0.35,
      })
    : { interim_results: true };

  const fallback = createInferenceStt(fallbackModel, input.language, fallbackOptions);

  return new stt.FallbackAdapter({
    sttInstances: [primary, fallback],
    ...fallbackAdapterOptions(),
  });
}
