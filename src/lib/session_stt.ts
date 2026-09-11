import { FallbackAdapter, inference, type STT } from '@livekit/agents';

export type BuildSessionSttInput = {
  primaryModel: string;
  fallbackModel?: string | null;
  language: string;
  modelOptions: Record<string, unknown>;
};

/** Primary LiveKit inference STT with optional fallback when quota/transient errors hit. */
export function buildSessionStt(input: BuildSessionSttInput): STT {
  const make = (model: string) =>
    new inference.STT({
      model,
      language: input.language,
      modelOptions: input.modelOptions,
    });

  const primary = make(input.primaryModel);
  const fallbackModel = input.fallbackModel?.trim();
  if (!fallbackModel || fallbackModel === input.primaryModel) {
    return primary;
  }

  return new FallbackAdapter({
    sttInstances: [primary, make(fallbackModel)],
    maxRetryPerSTT: 2,
    retryIntervalMs: 400,
    attemptTimeoutMs: 8000,
  });
}
