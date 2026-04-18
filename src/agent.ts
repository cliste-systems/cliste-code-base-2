import 'dotenv/config';

import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as lkTurn from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  inference,
  voice,
} from '@livekit/agents';
import type { RemoteParticipant } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';

import { stripForbiddenTtsPhrasesStreaming } from './lib/tts_text_sanitize.js';
import { linkAppointmentToCallLog } from './lib/booking.js';
import { formatBusinessHoursForPrompt } from './lib/business_hours.js';
import { estimateCallCostUsd } from './lib/call_cost_estimate.js';
import { postprocessCallTranscript } from './lib/call_postprocess.js';
import { insertCallLog } from './lib/call_logs.js';
import { maskPhone, redactPii } from './lib/gdpr.js';
import { classifyCallerLine, type CallerLineInfo } from './lib/phone_classify.js';
import { buildSalonSystemPrompt } from './lib/prompt.js';
import { stripeIsConfigured } from './lib/stripe.js';
import { getSalonForCall, getSalonServices, type SalonServiceRow } from './lib/supabase.js';
import {
  SalonTools,
  assistantTextSoundsLikeFakeHangup,
  disconnectSalonCallerLeg,
  type SalonAgentUserData,
} from './lib/tools.js';
import {
  currentBillingPeriodStart,
  finishUsageRecord,
  planQuotaMinutes,
  startUsageRecord,
} from './lib/usage.js';

const DEFAULT_TEST_PHONE = '+15551234567';

/** Stored in call_logs.transcript; cap size for DB and UI. */
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_TOOL_SNIPPET_CHARS = 800;

type TranscriptLine = { at: number; seq: number; line: string };

function truncateForTranscript(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) {
    return t;
  }
  const head = Math.max(0, max - 24);
  return `${t.slice(0, head)}… [truncated]`;
}

function mergeTranscriptLines(parts: TranscriptLine[]): string | null {
  if (parts.length === 0) {
    return null;
  }
  const sorted = [...parts].sort((a, b) => a.at - b.at || a.seq - b.seq);
  let text = sorted.map((p) => p.line).join('\n\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[Transcript truncated for storage.]`;
  }
  return text;
}

type RoutingHint = { slug?: string; phone?: string };

function parseMetadataRouting(metadata: string): RoutingHint {
  if (!metadata.trim()) {
    return {};
  }
  try {
    const p = JSON.parse(metadata) as Record<string, unknown>;
    const slugRaw = p.organization_slug ?? p.salon_slug ?? p.slug;
    const slug = typeof slugRaw === 'string' ? slugRaw.trim() : undefined;
    const phoneRaw =
      p.phone_number ??
      p.dialedNumber ??
      p.trunkPhoneNumber ??
      p.trunk_phone_number;
    const phone = typeof phoneRaw === 'string' ? phoneRaw.trim() : undefined;
    const hint: RoutingHint = {};
    if (slug) {
      hint.slug = slug;
    }
    if (phone) {
      hint.phone = phone;
    }
    return hint;
  } catch {
    return {};
  }
}

function routingFromParticipantAttributes(attrs: Record<string, string>): RoutingHint {
  let slug: string | undefined;
  for (const key of ['organization_slug', 'salon_slug', 'slug'] as const) {
    const v = attrs[key];
    if (v?.trim()) {
      slug = v.trim();
      break;
    }
  }
  const sip = attrs['sip.trunkPhoneNumber'] ?? attrs['sip.trunk_phone_number'];
  const phone = sip?.trim();
  const hint: RoutingHint = {};
  if (slug) {
    hint.slug = slug;
  }
  if (phone) {
    hint.phone = phone;
  }
  return hint;
}

function resolveSalonRouting(job: JobContext['job'], participant: RemoteParticipant): RoutingHint {
  const jobM = parseMetadataRouting(job.metadata ?? '');
  const roomM = job.room?.metadata ? parseMetadataRouting(job.room.metadata) : {};
  const part = routingFromParticipantAttributes(participant.attributes);

  const slug =
    jobM.slug ??
    roomM.slug ??
    part.slug ??
    process.env.DEFAULT_SALON_SLUG?.trim() ??
    undefined;

  const phone =
    part.phone ??
    jobM.phone ??
    roomM.phone ??
    process.env.DEFAULT_SALON_PHONE?.trim() ??
    DEFAULT_TEST_PHONE;

  const hint: RoutingHint = {};
  if (slug) {
    hint.slug = slug;
  }
  hint.phone = phone;
  return hint;
}

/** Best-effort E.164 or display string for call_logs.caller_number (NOT NULL). */
function callerNumberFromParticipant(participant: RemoteParticipant): string {
  const id = (participant.identity ?? '').trim();
  if (id.toLowerCase().startsWith('sip_')) {
    const rest = id.slice(4).trim();
    if (rest.startsWith('+')) {
      return rest;
    }
    const digits = rest.replace(/\D/g, '');
    return digits ? `+${digits}` : rest || 'unknown';
  }
  const attrs = participant.attributes ?? {};
  const sip =
    attrs['sip.phoneNumber'] ??
    attrs['sip.trunkPhoneNumber'] ??
    attrs['sip.trunk_phone_number'] ??
    '';
  const t = sip.trim();
  if (t.startsWith('+')) {
    return t;
  }
  const d = t.replace(/\D/g, '');
  if (d.length >= 10) {
    return `+${d}`;
  }
  const fromIdentity = id.replace(/\D/g, '');
  if (fromIdentity.length >= 10) {
    return `+${fromIdentity}`;
  }
  return id || 'unknown';
}

function formatServicesList(services: SalonServiceRow[]): string {
  if (services.length === 0) {
    return '(no services listed)';
  }
  return services
    .map((row) => {
      const name = typeof row.name === 'string' ? row.name : 'Service';
      const parts = [name];
      if (typeof row.description === 'string' && row.description) {
        parts.push(row.description);
      }
      if (row.price != null) {
        const pv =
          typeof row.price === 'number' ? String(row.price) : String(row.price).trim();
        if (pv) {
          parts.push(`price: ${pv} euros`);
        }
      }
      return parts.join(' — ');
    })
    .join('; ');
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const participant = await ctx.waitForParticipant();
    const routing = resolveSalonRouting(ctx.job, participant);

    const salon = await getSalonForCall({
      ...(routing.slug ? { slug: routing.slug } : {}),
      ...(routing.phone ? { phone: routing.phone } : {}),
    });
    if (!salon) {
      console.error('No organization found for routing', routing);
      ctx.shutdown('unknown_organization');
      return;
    }

    console.info('Salon loaded', {
      id: salon.id,
      slug: salon.slug,
      name: salon.name,
      phone: salon.phone_number,
      promptChars: salon.custom_prompt?.length ?? 0,
      greetingSet: Boolean(salon.greeting?.trim()),
    });

    const services = await getSalonServices(salon.id);
    const servicesList = formatServicesList(services);
    const custom = salon.custom_prompt?.trim() || 'Be professional, concise, and helpful.';

    const now = new Date();
    const nowUtcIso = now.toISOString();
    const bookingTz = process.env.SALON_TIMEZONE?.trim() || 'UTC';
    let todaySalonTz = nowUtcIso;
    try {
      todaySalonTz = now.toLocaleDateString('en-GB', {
        timeZone: bookingTz,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      /* invalid SALON_TIMEZONE */
    }
    const exampleYear = now.getUTCFullYear();
    const exampleIso = `${exampleYear}-04-15T15:00:00.000Z`;

    const hoursBlock = formatBusinessHoursForPrompt(salon.business_hours, bookingTz);

    const isNativePlan = String(salon.tier ?? '').toLowerCase() === 'native';

    // Classify the calling line up-front so the prompt can carry the number +
    // a one-liner steering the agent (skip asking when it's a mobile, ask once
    // for an SMS-capable mobile when it's a landline, etc.). Saves 1–2 turns.
    const earlyCallerNumberRaw = callerNumberFromParticipant(participant);
    const callerLine: CallerLineInfo = classifyCallerLine(earlyCallerNumberRaw);
    console.info('Caller line classified', {
      raw: earlyCallerNumberRaw,
      e164: callerLine.e164,
      kind: callerLine.kind,
      canReceiveSms: callerLine.canReceiveSms,
    });

    // Only surface the pay-online branch when STRIPE_SECRET_KEY is present.
    // Keeps the agent from apologising on-call that online payment isn't set up.
    const stripeAvailable = stripeIsConfigured();
    if (!stripeAvailable) {
      console.warn(
        '[agent] STRIPE_SECRET_KEY not set — pay-online flow disabled this call. Set it in Railway env to enable.',
      );
    }

    const systemPrompt = buildSalonSystemPrompt({
      salonName: salon.name,
      salonTier: salon.tier,
      ownerInstructions: custom,
      hoursBlock,
      servicesList,
      callerLine,
      bookingTz,
      nowUtcIso,
      todaySalonTz,
      exampleIso,
      isNativePlan,
      stripeAvailable,
    });

    // (legacy inline mega-prompt removed — see buildSalonSystemPrompt in lib/prompt.ts)

    const salonTools = new SalonTools();
    const callStartedAt = Date.now();
    const callerNumber = earlyCallerNumberRaw;
    const roomName =
      (typeof ctx.room.name === 'string' && ctx.room.name.trim()) ||
      (ctx.job.room && typeof (ctx.job.room as { name?: string }).name === 'string'
        ? String((ctx.job.room as { name: string }).name).trim()
        : '') ||
      '';

    // Kick off the per-call metering row BEFORE the caller even says hello so
    // crashes mid-call still show up in the dashboard's usage meter. Failures
    // are swallowed inside startUsageRecord — metering must never take a live
    // call off the line.
    const callSidAttr =
      (participant.attributes?.['sip.callID'] ??
        participant.attributes?.['sip.callId'] ??
        participant.attributes?.['sip.call_id'] ??
        '') || null;
    const usageRecordIdPromise = startUsageRecord({
      organizationId: salon.id,
      planTier: salon.plan_tier ?? null,
      planQuotaMinutes: planQuotaMinutes(salon.plan_tier),
      callSid: callSidAttr,
      roomName: roomName || null,
      callerNumber,
      billingPeriodStart: currentBillingPeriodStart(salon.billing_period_start ?? null),
    });

    const sessionUserData: SalonAgentUserData = {
      organizationId: salon.id,
      salonName: salon.name,
      bookingLinkUrl: salon.fresha_url ?? null,
      callerPhone: callerNumber,
      sessionFlags: {
        appointmentBooked: false,
        linkSent: false,
        actionTicketCreated: false,
        smsSent: 0,
        endPhoneCallUsed: false,
        paymentLinksSent: 0,
      },
      nativePlan: isNativePlan,
      businessHours: salon.business_hours,
      bookingTimeZone: bookingTz,
      lastBookedAppointmentId: null,
      ...(roomName && participant.identity
        ? {
            endCallTarget: {
              roomName,
              callerIdentity: participant.identity,
            },
          }
        : {}),
    };

    /** Default flux-general (reliable on phone lines); override e.g. deepgram/nova-3:en for Cloud parity. */
    const inferenceSttModel =
      process.env.LIVEKIT_INFERENCE_STT_MODEL?.trim() || 'deepgram/flux-general';
    const inferenceSttLanguage = process.env.LIVEKIT_INFERENCE_STT_LANGUAGE?.trim() || 'en';
    const inferenceLlmModel =
      process.env.LIVEKIT_INFERENCE_LLM_MODEL?.trim() || 'openai/gpt-4o-mini';
    const sttPrimaryIsFlux = inferenceSttModel.toLowerCase().includes('flux');
    const sttIsDeepgram = inferenceSttModel.toLowerCase().includes('deepgram');

    const ttsProviderRaw = process.env.SALON_TTS_PROVIDER?.trim().toLowerCase() || '';
    const elevenApiKey =
      process.env.ELEVEN_API_KEY?.trim() || process.env.ELEVENLABS_API_KEY?.trim() || '';
    const openaiApiKeyForTts = process.env.OPENAI_API_KEY?.trim() || '';
    let ttsMode: 'elevenlabs' | 'openai';
    if (ttsProviderRaw === 'openai') {
      ttsMode = 'openai';
    } else if (ttsProviderRaw === 'elevenlabs') {
      ttsMode = 'elevenlabs';
    } else if (elevenApiKey) {
      ttsMode = 'elevenlabs';
    } else if (openaiApiKeyForTts) {
      ttsMode = 'openai';
    } else {
      console.error(
        'No TTS credentials: set SALON_TTS_PROVIDER=openai with OPENAI_API_KEY, or set ELEVENLABS_API_KEY (and optional SALON_TTS_PROVIDER=elevenlabs).',
      );
      ctx.shutdown('missing_tts_credentials');
      return;
    }
    if (ttsMode === 'openai' && !openaiApiKeyForTts) {
      console.error('SALON_TTS_PROVIDER=openai requires OPENAI_API_KEY in the worker environment.');
      ctx.shutdown('missing_openai_key');
      return;
    }
    if (ttsMode === 'elevenlabs' && !elevenApiKey) {
      console.error(
        'SALON_TTS_PROVIDER=elevenlabs requires ELEVEN_API_KEY or ELEVENLABS_API_KEY (never commit keys).',
      );
      ctx.shutdown('missing_elevenlabs_key');
      return;
    }

    const elevenVoiceId =
      process.env.ELEVEN_VOICE_ID?.trim() || 'C92s6vssSLlabgIln1iY';
    // eleven_flash_v2_5 is ElevenLabs' real-time agent model (~75ms inference
    // vs ~250ms for turbo_v2_5), recommended for voice agents. Also avoids
    // the tail-streaming artefact turbo produced on short "goodbye!" lines
    // that callers heard as a drawn-out "aaaaaa".
    const elevenModel =
      (process.env.ELEVEN_TTS_MODEL?.trim() || 'eleven_flash_v2_5') as elevenlabs.TTSModels;
    const elevenStreamingLatency = Number.parseInt(process.env.ELEVEN_STREAMING_LATENCY ?? '4', 10);
    // Flash sounds best with slightly higher stability + lower style than turbo:
    // turbo's defaults (0.48 / 0.35) overshoot on flash and cause mushy prosody.
    const elevenVoiceStability = Number.parseFloat(process.env.ELEVEN_VOICE_STABILITY ?? '0.55');
    const elevenVoiceSimilarity = Number.parseFloat(process.env.ELEVEN_VOICE_SIMILARITY ?? '0.80');
    const elevenVoiceStyle = Number.parseFloat(process.env.ELEVEN_VOICE_STYLE ?? '0.25');

    const openaiTtsModel =
      (process.env.OPENAI_TTS_MODEL?.trim() || 'gpt-4o-mini-tts') as openai.TTSModels | string;
    const openaiTtsVoice = (process.env.OPENAI_TTS_VOICE?.trim() || 'coral') as openai.TTSVoices;
    const openaiTtsSpeed = Number.parseFloat(process.env.OPENAI_TTS_SPEED ?? '1');
    const openaiTtsInstructions = process.env.OPENAI_TTS_INSTRUCTIONS?.trim();

    // With the turn-detector EOU model, 'dynamic' endpointing adapts the
    // silence threshold to each caller's natural rhythm. minDelay 200 gives
    // fast replies without clipping; maxDelay 2500 protects longer pauses
    // mid-spell ("B…R…E…N…"). Override via env if needed.
    const endpointMinMs = Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MIN_MS ?? '200', 10);
    const endpointMaxMs = Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MAX_MS ?? '2500', 10);
    const endpointMode = (process.env.LIVEKIT_ENDPOINTING_MODE?.trim() || 'dynamic') as
      | 'fixed'
      | 'dynamic';
    const useTurnDetector =
      (process.env.LIVEKIT_USE_TURN_DETECTOR?.trim().toLowerCase() || 'on') !== 'off';

    // The EnglishModel constructor can throw synchronously if the HuggingFace
    // model cache is empty (npm run download-files was skipped) or the
    // onnxruntime-node build is missing for the target arch. If anything goes
    // wrong, fall back to STT/VAD turn detection so the worker still ANSWERS
    // calls — losing ~200ms of latency is infinitely better than dead air.
    let turnDetectorInstance: InstanceType<typeof lkTurn.turnDetector.EnglishModel> | null = null;
    if (useTurnDetector) {
      try {
        turnDetectorInstance = new lkTurn.turnDetector.EnglishModel();
      } catch (err) {
        console.error(
          '[agent] EOU turn-detector could not be constructed — falling back to VAD/STT',
          err instanceof Error ? err.message : err,
        );
        turnDetectorInstance = null;
      }
    }
    /** STT interim text can interrupt agent speech without the VAD minDuration guard; SIP echo/noise often yields one-word junk. Default 2 avoids killing the reply before the caller hears you. */
    const interruptionMinMs = Number.parseInt(process.env.LIVEKIT_INTERRUPTION_MIN_MS ?? '500', 10);
    const interruptionMinWords = Number.parseInt(process.env.LIVEKIT_INTERRUPTION_MIN_WORDS ?? '2', 10);

    const menuTokens = services.flatMap((row) => {
      const n = typeof row.name === 'string' ? row.name.trim() : '';
      return n ? n.split(/[\s,/]+/).filter((w) => w.length > 1) : [];
    });
    const salonNameTokens = salon.name ? salon.name.split(/\s+/).filter((w) => w.length > 1) : [];
    const envExtra =
      process.env.LIVEKIT_STT_EXTRA_KEYTERMS?.split(/[,;]+/)
        .map((s) => s.trim())
        .filter((w) => w.length > 1) ?? [];
    const sttKeyterms = [
      ...new Set([...envExtra, ...salonNameTokens, ...menuTokens]),
    ].slice(0, 100);

    const session = new voice.AgentSession<SalonAgentUserData>({
      stt: new inference.STT({
        model: inferenceSttModel,
        language: inferenceSttLanguage,
        modelOptions: {
          smart_format: false,
          punctuate: true,
          interim_results: true,
          // Slightly higher than 45ms: short words (“fade”, etc.) get a bit more audio before EOU.
          endpointing: Number.parseInt(process.env.LIVEKIT_STT_ENDPOINTING_MS ?? '120', 10) || 120,
          filler_words: true,
          ...(sttKeyterms.length > 0 ? { keyterms: sttKeyterms } : {}),
        },
        ...(sttPrimaryIsFlux ? { fallback: 'deepgram/nova-3:en-GB' } : {}),
      }),
      vad: ctx.proc.userData.vad as silero.VAD,
      llm: new inference.LLM({
        model: inferenceLlmModel as inference.LLMModels,
        modelOptions: {
          // Lower temp (was 0.68) = tighter, less-waffly replies. Voice agents
          // sound better with small lexical variation, not paragraph-level.
          temperature: Number.parseFloat(process.env.LIVEKIT_LLM_TEMPERATURE ?? '0.45'),
          // Tighter cap (was 300). With the slimmer system prompt the model
          // no longer needs headroom to quote long rules — caps responses at
          // ~3 short sentences, which is where the prompt already wants it.
          max_completion_tokens: Number.parseInt(
            process.env.LIVEKIT_LLM_MAX_TOKENS ?? '220',
            10,
          ),
          // Do not set reasoning_effort here — it is for OpenAI reasoning models (o1/o3), not gpt-4o-mini,
          // and can cause chat completion errors → no assistant text → silent call.
        },
      }),
      tts:
        ttsMode === 'openai'
          ? new openai.TTS({
              apiKey: openaiApiKeyForTts,
              model: openaiTtsModel,
              voice: openaiTtsVoice,
              speed: Number.isFinite(openaiTtsSpeed) ? openaiTtsSpeed : 1,
              ...(openaiTtsInstructions ? { instructions: openaiTtsInstructions } : {}),
            })
          : new elevenlabs.TTS({
              apiKey: elevenApiKey,
              voiceId: elevenVoiceId,
              model: elevenModel,
              streamingLatency: Number.isFinite(elevenStreamingLatency) ? elevenStreamingLatency : 4,
              voiceSettings: {
                stability: Number.isFinite(elevenVoiceStability) ? elevenVoiceStability : 0.48,
                similarity_boost: Number.isFinite(elevenVoiceSimilarity) ? elevenVoiceSimilarity : 0.82,
                style: Number.isFinite(elevenVoiceStyle) ? elevenVoiceStyle : 0.35,
              },
            }),
      userData: sessionUserData,
      preemptiveGeneration: true,
      maxToolSteps: 5,
      turnHandling: {
        // LiveKit's open-weights EOU transformer (~500MB RAM, <100ms CPU
        // inference per turn) predicts end-of-utterance from language
        // context — noticeably faster + more accurate than VAD silence alone,
        // especially when callers pause mid-sentence. Falls back to STT EOU
        // cues on Deepgram if the detector is disabled in env or failed to
        // initialise (e.g. model files not downloaded yet).
        turnDetection: turnDetectorInstance ?? (sttIsDeepgram ? 'stt' : 'vad'),
        endpointing: {
          mode: endpointMode,
          minDelay: Number.isFinite(endpointMinMs) ? endpointMinMs : 200,
          maxDelay: Number.isFinite(endpointMaxMs) ? endpointMaxMs : 2500,
        },
        interruption: {
          minDuration: Number.isFinite(interruptionMinMs) ? interruptionMinMs : 500,
          minWords: Number.isFinite(interruptionMinWords) ? interruptionMinWords : 2,
        },
      },
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const err = ev.error;
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : String(err);
      console.error('[AgentSession] pipeline error', msg, err);
    });

    /** If assistant TTS was cut off (often before the caller heard anything), re-speak so they never get dead air. */
    const silenceRecoveryDelayMs = Number.parseInt(process.env.LIVEKIT_SILENCE_RECOVERY_MS ?? '550', 10);
    const silenceRecoveryMaxPerCall = Number.parseInt(
      process.env.LIVEKIT_SILENCE_RECOVERY_MAX_PER_CALL ?? '5',
      10,
    );
    let silenceRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let silenceRecoveryCount = 0;
    /** If the model says "end phone call" as speech, we still disconnect after a short delay (real tool may run first). */
    let fakeHangupGuardTimer: ReturnType<typeof setTimeout> | null = null;

    const clearSilenceRecoveryTimer = () => {
      if (silenceRecoveryTimer) {
        clearTimeout(silenceRecoveryTimer);
        silenceRecoveryTimer = null;
      }
    };

    const clearFakeHangupGuardTimer = () => {
      if (fakeHangupGuardTimer) {
        clearTimeout(fakeHangupGuardTimer);
        fakeHangupGuardTimer = null;
      }
    };

    const scheduleSilenceRecoveryAfterCutoff = () => {
      clearSilenceRecoveryTimer();
      const delay = Number.isFinite(silenceRecoveryDelayMs) ? silenceRecoveryDelayMs : 550;
      silenceRecoveryTimer = setTimeout(() => {
        silenceRecoveryTimer = null;
        try {
          if (session.userState === 'speaking') {
            return;
          }
          if (session.agentState !== 'listening') {
            return;
          }
          const maxR = Number.isFinite(silenceRecoveryMaxPerCall) ? silenceRecoveryMaxPerCall : 5;
          if (silenceRecoveryCount >= maxR) {
            return;
          }
          silenceRecoveryCount += 1;
          void session.generateReply({
            instructions:
              'Your previous spoken reply was cut off or may not have played on the caller’s phone (line glitch or false interruption). Speak right away: one short warm line—sorry about that, you’re still with them—then continue helping with their last request from the conversation (booking, service, time). Use tools if needed. Do not go silent; do not ask them to repeat everything unless you have no context at all.',
          });
        } catch (e) {
          console.error('[AgentSession] silence recovery failed', e);
        }
      }, delay);
    };

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') {
        clearSilenceRecoveryTimer();
      }
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      const { speechHandle } = ev;
      speechHandle.addDoneCallback((sh) => {
        if (!sh.interrupted) {
          return;
        }
        scheduleSilenceRecoveryAfterCutoff();
      });
    });

    const transcriptParts: TranscriptLine[] = [];
    let transcriptSeq = 0;

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const { item } = ev;
      if (item.type !== 'message') {
        return;
      }
      const { role } = item;
      if (role === 'developer' || role === 'system') {
        return;
      }
      const text = item.textContent?.trim();
      if (!text) {
        return;
      }
      if (role === 'assistant' && assistantTextSoundsLikeFakeHangup(text)) {
        clearFakeHangupGuardTimer();
        fakeHangupGuardTimer = setTimeout(() => {
          fakeHangupGuardTimer = null;
          const ud = session.userData;
          if (ud.sessionFlags.endPhoneCallUsed) {
            return;
          }
          console.warn(
            '[agent] assistant output contained fake hang-up phrase; running disconnectSalonCallerLeg',
          );
          void disconnectSalonCallerLeg(session, ud, async () => {
            await new Promise((r) => setTimeout(r, 650));
          });
        }, 500);
      }
      const label = role === 'user' ? 'Caller' : 'Assistant';
      const interruptedNote = item.interrupted && role === 'assistant' ? ' [cut off]' : '';
      transcriptParts.push({
        at: ev.createdAt,
        seq: transcriptSeq++,
        line: `${label}: ${text}${interruptedNote}`,
      });
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      for (const [call, out] of voice.zipFunctionCallsAndOutputs(ev)) {
        transcriptParts.push({
          at: call.createdAt ?? ev.createdAt,
          seq: transcriptSeq++,
          line: `[Tool] ${call.name} ${truncateForTranscript(call.args, MAX_TOOL_SNIPPET_CHARS)}`,
        });
        if (out) {
          const prefix = out.isError ? '[Tool error] ' : '[Tool result] ';
          transcriptParts.push({
            at: out.createdAt,
            seq: transcriptSeq++,
            line: `${prefix}${truncateForTranscript(out.output, MAX_TOOL_SNIPPET_CHARS)}`,
          });
        }
      }
    });

    let callLogWritten = false;
    session.on(voice.AgentSessionEventTypes.Close, async () => {
      if (callLogWritten) {
        return;
      }
      callLogWritten = true;
      clearSilenceRecoveryTimer();
      clearFakeHangupGuardTimer();
      try {
        const ud = session.userData;
        if (!ud?.organizationId) {
          return;
        }
        const durationSeconds = Math.max(0, Math.round((Date.now() - callStartedAt) / 1000));
        let outcome = 'handled';
        if (ud.sessionFlags.appointmentBooked) {
          outcome = 'appointment_booked';
        } else if (ud.sessionFlags.linkSent) {
          outcome = 'link_sent';
        } else if (ud.sessionFlags.actionTicketCreated) {
          outcome = 'action_required';
        } else if (ud.sessionFlags.endPhoneCallUsed) {
          outcome = 'call_ended_by_agent';
        }
        const verbatimRaw = mergeTranscriptLines(transcriptParts);
        // GDPR data minimisation: strip likely card-numbers / CVVs / IBAN / PPS
        // from the transcript BEFORE we hand it to the post-process LLM
        // (third-party processor) and BEFORE persisting to call_logs. Names,
        // phones and booking refs stay because they are the legitimate
        // purpose of the call and live alongside in `appointments`.
        const verbatim = verbatimRaw ? redactPii(verbatimRaw) : null;
        let transcriptReview: string | null = null;
        let aiSummary: string | null = null;
        let didPostprocess = false;
        if (verbatim) {
          const pp = await postprocessCallTranscript({
            verbatim,
            salonName: salon.name,
            services,
            outcome,
            inferenceLlmModel,
          });
          transcriptReview = pp.transcriptReview ? redactPii(pp.transcriptReview) : null;
          aiSummary = pp.aiSummary ? redactPii(pp.aiSummary) : null;
          didPostprocess = true;
        }
        const ttsModelForCost = ttsMode === 'openai' ? String(openaiTtsModel) : String(elevenModel);
        const costEstimate = estimateCallCostUsd({
          durationSeconds,
          smsSegmentsSent: ud.sessionFlags.smsSent,
          didPostprocess,
          transcriptChars: verbatim?.length ?? 0,
          sttModel: inferenceSttModel,
          llmModel: inferenceLlmModel,
          ttsModel: ttsModelForCost,
        });
        const callLogId = await insertCallLog({
          organizationId: ud.organizationId,
          callerNumber,
          durationSeconds,
          outcome,
          transcript: verbatim,
          transcriptReview,
          aiSummary,
          costEstimate,
        });
        if (callLogId && ud.lastBookedAppointmentId) {
          await linkAppointmentToCallLog(ud.lastBookedAppointmentId, callLogId);
        }
        // Close out the metering row the nightly Stripe-sync cron reads.
        const usageRecordId = await usageRecordIdPromise;
        if (usageRecordId) {
          await finishUsageRecord({ usageId: usageRecordId, durationSeconds });
        }
      } catch (err) {
        console.error('[AgentSession] close handler failed', err);
      }
    });

    /** Strips spoken tool-name junk from the LLM text stream before TTS so callers never hear it. */
    class SalonReceptionAgent extends voice.Agent<SalonAgentUserData> {
      override async ttsNode(
        text: ReadableStream<string>,
        modelSettings: Parameters<voice.Agent<SalonAgentUserData>['ttsNode']>[1],
      ) {
        return voice.Agent.default.ttsNode(
          this,
          stripForbiddenTtsPhrasesStreaming(text),
          modelSettings,
        );
      }
    }

    const agent = new SalonReceptionAgent({
      instructions: systemPrompt,
      tools: salonTools.fncCtx(!isNativePlan, stripeAvailable),
    });

    await session.start({ agent, room: ctx.room });

    // GDPR Art 13 — caller must be informed that they are speaking to an AI
    // and that the call is processed for the booking before they share
    // personal info. Set CLISTE_AI_DISCLOSURE_OPENING=off to suppress (only
    // do that if the salon already plays a pre-call IVR notice).
    const disclosureMode = (process.env.CLISTE_AI_DISCLOSURE_OPENING ?? 'on')
      .trim()
      .toLowerCase();
    const aiDisclosure =
      disclosureMode === 'off'
        ? ''
        : process.env.CLISTE_AI_DISCLOSURE_TEXT?.trim() ||
          "Just so you know, I'm an AI assistant for the salon and your call is processed to help with your booking.";

    const fixedGreeting = salon.greeting?.trim();
    if (fixedGreeting) {
      session.say(fixedGreeting);
      if (aiDisclosure) {
        // A separate `say` so the salon's greeting plays in their voice and
        // the disclosure is a clearly-distinct second sentence.
        session.say(aiDisclosure);
      }
    } else {
      await session.generateReply({
        instructions: `The caller just connected; they have not spoken yet. You speak first. Say ONE opening only, following this pattern exactly in spirit:
"Hi, thanks for calling ${salon.name} — how can I help you today?"
You may add ONE short clause (e.g. that you can help with bookings and services). Max 35 words. Use the salon name ${salon.name}.${aiDisclosure ? ` Then add EXACTLY this sentence on a new breath, no paraphrasing: "${aiDisclosure}"` : ' Never mention AI or robots.'} Match tone from owner instructions if any.`,
      });
    }
  },
});

const _agentNameRaw = process.env.LIVEKIT_AGENT_NAME;
const resolvedAgentName =
  _agentNameRaw === undefined ? 'cliste-salon-node' : _agentNameRaw.trim();

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    ...(resolvedAgentName ? { agentName: resolvedAgentName } : {}),
  }),
);
