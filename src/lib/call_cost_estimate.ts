/**
 * Estimated per-call infrastructure cost (USD). Heuristic — tune env vars against your real invoices.
 *
 * Covers typical Cliste voice stack:
 * - LiveKit Cloud (room / participant / agent minutes — single blended rate by default)
 * - Speech-to-text (Deepgram-style; set to 0 if fully bundled in LiveKit)
 * - LLM (OpenAI-style pricing for voice-turn + tool calls; rough token model)
 * - TTS (ElevenLabs — default flat USD/min; optional per‑character model if USD/min is 0)
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

/**
 * @param smsSegmentsSent — Twilio SMS count (booking link + confirmation texts, etc.)
 * @param didPostprocess — transcript review LLM ran after the call
 * @param transcriptChars — length of verbatim transcript (for postprocess token heuristic)
 */
export function estimateCallCostUsd(input: {
  durationSeconds: number;
  smsSegmentsSent: number;
  didPostprocess: boolean;
  transcriptChars: number;
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

  /* STT (often Deepgram via LiveKit Inference). Set fraction or CALL_COST_STT_USD_PER_MIN=0 if bundled in LK. */
  const sttFraction = envFloat('CALL_COST_STT_BILLED_FRACTION_OF_WALL', 0.5);
  const sttPerMin = envFloat('CALL_COST_STT_USD_PER_MIN', 0.006);
  const stt = durationMin * sttFraction * sttPerMin;

  /* Voice LLM: token heuristics per minute of call (tool + reply turns). */
  const llmFlatPerMin = envFloat('CALL_COST_LLM_USD_PER_MIN_FLAT', Number.NaN);
  const inTokPerMin = envFloat('CALL_COST_LLM_INPUT_TOKENS_PER_MIN', 1400);
  const outTokPerMin = envFloat('CALL_COST_LLM_OUTPUT_TOKENS_PER_MIN', 450);
  const inPerM = envFloat('CALL_COST_LLM_INPUT_USD_PER_1M_TOKENS', 0.15);
  const outPerM = envFloat('CALL_COST_LLM_OUTPUT_USD_PER_1M_TOKENS', 0.6);
  const inTok = durationMin * inTokPerMin;
  const outTok = durationMin * outTokPerMin;
  const llmVoiceFromTokens = (inTok / 1_000_000) * inPerM + (outTok / 1_000_000) * outPerM;
  const llmVoice = Number.isFinite(llmFlatPerMin)
    ? durationMin * llmFlatPerMin
    : llmVoiceFromTokens;

  /**
   * TTS (ElevenLabs). Plan/character pricing varies; voice agents often land ~$0.10–0.18/min billed.
   * Default: flat **USD per wall-clock minute** (simplest vs invoices).
   * Set `CALL_COST_TTS_USD_PER_MIN=0` to use per‑character math (`CALL_COST_TTS_CHARS_PER_MIN` × `CALL_COST_TTS_USD_PER_1K_CHARS`) instead.
   */
  const ttsUsdPerMin = envFloat('CALL_COST_TTS_USD_PER_MIN', 0.13);
  let tts: number;
  if (ttsUsdPerMin > 0) {
    tts = durationMin * ttsUsdPerMin;
  } else {
    const ttsCharsPerMin = envFloat('CALL_COST_TTS_CHARS_PER_MIN', 220);
    const ttsPer1kChars = envFloat('CALL_COST_TTS_USD_PER_1K_CHARS', 0.12);
    const ttsChars = durationMin * ttsCharsPerMin;
    tts = (ttsChars / 1000) * ttsPer1kChars;
  }

  /* Twilio: SIP inbound (adjust for region / number type). */
  const twilioVoicePerMin = envFloat('CALL_COST_TWILIO_VOICE_USD_PER_MIN', 0.009);
  const twilioVoice = durationMin * twilioVoicePerMin;

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
    'Heuristic estimate from call duration + SMS count; STT/TTS/LLM use fixed ratios. ' +
    'Tune CALL_COST_* env vars to match LiveKit, Twilio, ElevenLabs, and OpenAI invoices. ' +
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
    ratesVersion: '2026-04-03',
  };
}

function roundUsd(n: number): number {
  return Math.round(n * 100_000) / 100_000;
}
