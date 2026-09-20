import * as openai from '@livekit/agents-plugin-openai';

/** OpenAI GPT-Live Irish English feminine voice (9508 retail default). */
export const GPT_LIVE_RETAIL_VOICE_DEFAULT = 'willow';

/** Backend Responses model for tool/reasoning delegation. */
export const GPT_LIVE_RETAIL_BACKEND_DEFAULT = 'gpt-5.6-luna';

export function resolveGptLiveRetailVoice(): string {
  return process.env.CARA_GPT_LIVE_VOICE?.trim() || GPT_LIVE_RETAIL_VOICE_DEFAULT;
}

export function resolveGptLiveRetailBackendModel(): string {
  return process.env.CARA_GPT_LIVE_BACKEND_MODEL?.trim() || GPT_LIVE_RETAIL_BACKEND_DEFAULT;
}

/** Kavanaghs 9508 — full-duplex GPT-Live-1 with Irish voice (Option A). */
export function shouldUseGptLiveRetailStack(input: { conversationalRetailLine: boolean }): boolean {
  if (!input.conversationalRetailLine) return false;
  const raw = process.env.CARA_GPT_LIVE_RETAIL?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true;
}

export type ResolvedGptLiveRetailModel = {
  instance: openai.realtime.GPTLiveModel;
  label: string;
  voice: string;
  backendModel: string;
};

export function createGptLiveRetailModel(): ResolvedGptLiveRetailModel | null {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.warn('[gpt_live] OPENAI_API_KEY missing — falling back to inference retail stack');
    return null;
  }

  const voice = resolveGptLiveRetailVoice();
  const backendModel = resolveGptLiveRetailBackendModel();

  return {
    voice,
    backendModel,
    label: `openai/gpt-live-1:${voice}+${backendModel}`,
    instance: new openai.realtime.GPTLiveModel({
      voice,
      responsesOptions: {
        model: backendModel,
        instructions:
          'Speak Irish English. Use retail lookup tools when the caller asks about products, stock, hours, or departments. Keep spoken replies concise for phone.',
      },
    }),
  };
}

export function buildGptLiveRetailOpeningInstructions(greetingText: string): string {
  const trimmed = greetingText.trim();
  return (
    'You are answering an inbound phone call. Speak Irish English. ' +
    'Say this opening exactly, naturally and warmly, then stop and listen for the caller:\n' +
    `"${trimmed}"`
  );
}
