/**
 * Estimated per-call infrastructure cost (USD). Heuristic — tune env vars against your real invoices.
 *
 * Covers typical Cliste voice stack:
 * - LiveKit Cloud (room / participant / agent minutes — single blended rate by default)
 * - Speech-to-text via LiveKit Inference (set to 0 if fully bundled in LiveKit)
 * - LLM (OpenAI-style pricing for voice-turn + tool calls; rough token model)
 * - TTS (Cartesia per-character via LiveKit Inference; ElevenLabs flat USD/min fallback)
 * - Twilio SIP voice + SMS segments sent on the call
 * - Supabase (negligible per row)
 * - Post-call LLM (transcript review / summary in call_postprocess)
 *
 * Official pricing changes often; see vendor sites and adjust env defaults.
 */

export type CallCostBreakdownUsd = {
  livekit: number;
  stt: number;
  llmVoice: number;
  tts: number;
  twilioVoice: number;
  twilioSms: number;
  supabase: number;
  postprocessLlm: number;
};

export type CallCostEstimateRecord = {
  currency: 'USD';
  totalUsd: number;
  breakdown: CallCostBreakdownUsd;
  durationSeconds: number;
  smsSegmentsSent: number;
  didPostprocess: boolean;
  /** Model ids used for this estimate (from worker env at close time). */
  models: { stt: string; llm: string; tts: string };
  assumptions: string;
  ratesVersion: string;
};

function envFloat(key: string, fallback: number): number {
  const v = process.env[key]?.trim();
  if (!v) {
    return fallback;
  }
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key]?.trim();
  if (!v) {
    return fallback;
  }
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Count assistant speech characters in a verbatim transcript (excludes Caller/Tool lines). */
export function countAssistantTranscriptChars(transcript: string): number {
  let total = 0;
  for (const block of transcript.split(/\n\n+/)) {
    const trimmed = block.trim();
    if (trimmed.startsWith('Assistant:')) {
      total += trimmed.slice('Assistant:'.length).trim().length;
    }
  }
  return total;
}

function isCartesiaTtsModel(ttsModel: string): boolean {
  return ttsModel.toLowerCase().includes('cartesia');
}

/**
 * @param smsSegmentsSent — Twilio SMS count (booking link + confirmation texts, etc.)
 * @param didPostprocess — transcript review LLM ran after the call
 * @param transcriptChars — length of verbatim transcript (for postprocess token heuristic)
 * @param assistantTranscriptChars — assistant speech chars for Cartesia per-character billing
 */
export function estimateCallCostUsd(input: {
  durationSeconds: number;
  smsSegmentsSent: number;
  didPostprocess: boolean;
  transcriptChars: number;
  assistantTranscriptChars?: number;
  sttModel: string;
  llmModel: string;
  ttsModel: string;
}): CallCostEstimateRecord {
  const durationMin = Math.max(0, input.durationSeconds) / 60;

  /**
   * LiveKit Cloud agent / participant minutes (see https://livekit.io/pricing — plan-dependent).
   * If you prefer one blended “voice AI” $/min, raise this and zero STT/TTS/LLM with env.
   */
  const livekitPerMin = envFloat('CALL_COST_LIVEKIT_USD_PER_MIN', 0.01);
  const livekit = durationMin * livekitPerMin;

  /* STT via LiveKit Inference — billed on streamed audio for the full session. */
  const sttFraction = envFloat('CALL_COST_STT_BILLED_FRACTION_OF_WALL', 1);
  const sttPerMin = envFloat('CALL_COST_STT_USD_PER_MIN', 0.0075);
  const stt = durationMin * sttFraction * sttPerMin;

  /* Voice LLM: token heuristics per minute of call (tool + reply turns). Defaults match GPT-5.6 Luna. */
  const llmFlatPerMin = envFloat('CALL_COST_LLM_USD_PER_MIN_FLAT', Number.NaN);
  const inTokPerMin = envFloat('CALL_COST_LLM_INPUT_TOKENS_PER_MIN', 1400);
  const outTokPerMin = envFloat('CALL_COST_LLM_OUTPUT_TOKENS_PER_MIN', 450);
  const inPerM = envFloat('CALL_COST_LLM_INPUT_USD_PER_1M_TOKENS', 0.2);
  const outPerM = envFloat('CALL_COST_LLM_OUTPUT_USD_PER_1M_TOKENS', 1.2);
  const inTok = durationMin * inTokPerMin;
  const outTok = durationMin * outTokPerMin;
  const llmVoiceFromTokens = (inTok / 1_000_000) * inPerM + (outTok / 1_000_000) * outPerM;
  const llmVoice = Number.isFinite(llmFlatPerMin)
    ? durationMin * llmFlatPerMin
    : llmVoiceFromTokens;

  /**
   * TTS billing.
   * Cartesia via LiveKit Inference: $50/1M chars (Build/Ship tier).
   * ElevenLabs: flat USD/min when per-character billing is unavailable.
   */
  const ttsUsdPerMinOverride = envFloat('CALL_COST_TTS_USD_PER_MIN', Number.NaN);
  const cartesiaPer1mChars = envFloat('CALL_COST_CARTESIA_USD_PER_1M_CHARS', 50);
  const cartesiaSsmlOverhead = envFloat('CALL_COST_CARTESIA_SSML_OVERHEAD_FRACTION', 0.2);
  const ttsCharsPerMin = envFloat('CALL_COST_TTS_CHARS_PER_MIN', 220);
  const ttsPer1kChars = envFloat('CALL_COST_TTS_USD_PER_1K_CHARS', 0.05);
  const assistantChars = Math.max(0, input.assistantTranscriptChars ?? 0);
  const cartesiaChars =
    assistantChars > 0 ? assistantChars * (1 + cartesiaSsmlOverhead) : durationMin * ttsCharsPerMin;

  let tts: number;
  if (Number.isFinite(ttsUsdPerMinOverride) && ttsUsdPerMinOverride > 0) {
    tts = durationMin * ttsUsdPerMinOverride;
  } else if (isCartesiaTtsModel(input.ttsModel) && assistantChars > 0) {
    tts = (cartesiaChars / 1_000_000) * cartesiaPer1mChars;
  } else if (isCartesiaTtsModel(input.ttsModel)) {
    tts = durationMin * envFloat('CALL_COST_CARTESIA_FALLBACK_USD_PER_MIN', 0.04);
  } else {
    const elevenPerMin = envFloat('CALL_COST_ELEVENLABS_USD_PER_MIN', 0.13);
    tts = durationMin * elevenPerMin;
  }

  /* Twilio Elastic SIP: per-minute rounding (invoice-accurate). */
  const twilioVoicePerMin = envFloat('CALL_COST_TWILIO_VOICE_USD_PER_MIN', 0.006);
  const twilioBilledMinutes = input.durationSeconds > 0 ? Math.ceil(durationMin) : 0;
  const twilioVoice = twilioBilledMinutes * twilioVoicePerMin;

  const twilioSmsEach = envFloat('CALL_COST_TWILIO_SMS_USD_EACH', 0.008);
  const twilioSms = Math.max(0, input.smsSegmentsSent) * twilioSmsEach;

  const supabaseFlat = envFloat('CALL_COST_SUPABASE_USD_PER_CALL', 0.00002);

  /* Post-call inference (transcript review + summary). */
  let postprocessLlm = 0;
  if (input.didPostprocess) {
    const base = envFloat('CALL_COST_POSTPROCESS_BASE_USD', 0.0004);
    const per1kChars = envFloat('CALL_COST_POSTPROCESS_USD_PER_1K_TRANSCRIPT_CHARS', 0.00008);
    const cappedChars = Math.min(input.transcriptChars, envInt('CALL_COST_POSTPROCESS_CHAR_CAP', 50_000));
    postprocessLlm = base + (cappedChars / 1000) * per1kChars;
  }

  const breakdown: CallCostBreakdownUsd = {
    livekit: roundUsd(livekit),
    stt: roundUsd(stt),
    llmVoice: roundUsd(llmVoice),
    tts: roundUsd(tts),
    twilioVoice: roundUsd(twilioVoice),
    twilioSms: roundUsd(twilioSms),
    supabase: roundUsd(supabaseFlat),
    postprocessLlm: roundUsd(postprocessLlm),
  };

  const totalUsd = roundUsd(
    breakdown.livekit +
      breakdown.stt +
      breakdown.llmVoice +
      breakdown.tts +
      breakdown.twilioVoice +
      breakdown.twilioSms +
      breakdown.supabase +
      breakdown.postprocessLlm,
  );

  const assumptions =
    'Heuristic estimate from call duration + SMS count; Cartesia TTS uses assistant transcript chars. ' +
    'Twilio billed in whole-minute increments. Tune CALL_COST_* env vars to match LiveKit, Twilio, and OpenAI invoices. ' +
    'Does not include matchServiceFromUtterance OpenAI calls, Action Inbox email, or one-off egress.';

  return {
    currency: 'USD',
    totalUsd,
    breakdown,
    durationSeconds: input.durationSeconds,
    smsSegmentsSent: input.smsSegmentsSent,
    didPostprocess: input.didPostprocess,
    models: {
      stt: input.sttModel,
      llm: input.llmModel,
      tts: input.ttsModel,
    },
    assumptions,
    ratesVersion: '2026-09-11',
  };
}

function roundUsd(n: number): number {
  return Math.round(n * 100_000) / 100_000;
}
