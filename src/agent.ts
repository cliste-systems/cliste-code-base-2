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
import { RoomServiceClient } from 'livekit-server-sdk';
import { fileURLToPath } from 'node:url';

import { buildCaraCallPrompt } from './lib/cara_prompt.js';
import { assistantOfferedBookingLinkConsent, callerDeclinedSmsConsent, callerGrantedSmsConsent } from './lib/booking_consent.js';
import {
  CaraTools,
  sendBookingLinkSmsForRoute,
  type CaraAgentUserData,
} from './lib/cara_tools.js';
import { estimateCallCostUsd } from './lib/call_cost_estimate.js';
import { postprocessCallTranscript } from './lib/call_postprocess.js';
import { insertCallLog, updateCallLogEnrichment } from './lib/call_logs.js';
import {
  assistantTextSoundsLikeFakeHangup,
  assistantTextSoundsLikeGoodbye,
  disconnectCallerLeg,
  waitForSessionPlayout,
} from './lib/end_call.js';
import { createElevenLabsTts } from './lib/elevenlabs-v3-http-tts.js';
import { greetingIncludesAiDisclosure } from './lib/greeting_compliance.js';
import {
  buildGreetingV3RenderConfig,
  greetingAudioCacheKey,
  loadCachedGreetingPcm,
  pcmToAudioFrameStream,
  renderGreetingPcmForCache,
  storeCachedGreetingPcm,
} from './lib/greeting_audio_cache.js';
import { maskPhone, redactPii } from './lib/gdpr.js';
import { assertOrgCallable } from './lib/org_gate.js';
import {
  callerE164ForBlocklist,
  checkCallerBlocklist,
  rejectBlockedCaller,
  stableCallSidFallback,
} from './lib/caller_blocklist.js';
import { classifyCallerLine, type CallerLineInfo } from './lib/phone_classify.js';
import { activeRoutes, isBookingRoute } from './lib/routing_links.js';
import {
  getOrgForCall,
  getSendableBusinessFiles,
  resolveOrgTimeZone,
  resolveOrgVoiceId,
} from './lib/supabase.js';
import { sayPrepared } from './lib/say_prepared.js';
import {
  assistantAskedAnythingElse,
  assistantClaimsLinkWasSent,
  callerAskedNewQuestion,
  callerAskedPhoneOrHumanBooking,
  callerPivotedFromSmsConsent,
  callerSaidNothingElse,
} from './lib/speech_triggers.js';
import {
  bufferTtsStreamBySentence,
  prepareTextForTtsStreaming,
  setActiveTtsModelForSanitizer,
} from './lib/tts_text_sanitize.js';
import {
  detectLikelySttGarble,
  soundsLikeBookingIntent,
  soundsLikeCancelOrChangeAppointment,
} from './lib/stt_garble.js';
import {
  buildAssemblyAiSttOptions,
  buildSttDomainPrompt,
  buildSttKeyterms,
  endpointingDefaults,
  isAssemblyAiSttModel,
  isU3RtProSttModel,
  resolveSttLatencyProfile,
  sttTurnSilenceDefaults,
} from './lib/stt_keyterms.js';
import {
  canonicalCallOutcome,
  postCallComplete,
  voiceWebhooksConfigured,
} from './lib/voice_api.js';
import {
  currentBillingPeriodStart,
  finishUsageRecord,
  planQuotaMinutes,
  reapZombieUsageRows,
  startUsageRecord,
  sumUsageMinutesThisPeriod,
} from './lib/usage.js';

const DEFAULT_TEST_PHONE = '+15551234567';
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_TOOL_SNIPPET_CHARS = 800;

const RESPONSE_FILLER_PHRASES = ['Right —', 'Let me see now…'] as const;

function resolveElevenVoiceSettings(): {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost?: true;
} {
  const speakerBoostRaw = process.env.ELEVEN_VOICE_SPEAKER_BOOST?.trim().toLowerCase();
  const settings = {
    // Slightly higher stability + lower style reduces turbo "screaming" / stretched vowels.
    stability: Number.parseFloat(process.env.ELEVEN_VOICE_STABILITY ?? '0.55') || 0.55,
    similarity_boost: Number.parseFloat(process.env.ELEVEN_VOICE_SIMILARITY ?? '0.8') || 0.8,
    style: Number.parseFloat(process.env.ELEVEN_VOICE_STYLE ?? '0.22') || 0.22,
  };
  if (speakerBoostRaw === 'true' || speakerBoostRaw === '1') {
    return { ...settings, use_speaker_boost: true };
  }
  return settings;
}

/** Tools that may block on HTTP/SMS — only these arm the thinking micro-ack. */
const SLOW_TOOL_ACK_NAMES = new Set([
  'sendDirectionsLink',
  'sendRoutingLink',
  'sendRoutingFile',
  'searchBusinessFile',
  'takeCallbackMessage',
  'transferToTeam',
]);

function soundsLikeCallerLineCheck(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!?.]+/g, '').replace(/\s+/g, ' ');
  if (!t) return false;
  return (
    /^(hello|hi|hey)$/.test(t) ||
    /\b(you there|still there|are you there|can you hear|anyone there)\b/.test(t)
  );
}

function assistantAskedForPhoneNumber(text: string): boolean {
  return /\b((?:your |the )?phone number|what(?:'s| is) your number|provide (?:me with )?(?:your )?(?:phone )?number|mobile number|contact number|number you(?:'re| are) calling from|give me your number)\b/i.test(
    text,
  );
}

type TranscriptLine = { at: number; seq: number; line: string };

function truncateForTranscript(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 24))}… [truncated]`;
}

function noteCallerGarble(
  flags: CaraAgentUserData['sessionFlags'],
  organizationId: string,
  text: string,
): void {
  if (!detectLikelySttGarble(text)) return;
  flags.likelySttGarble = true;
  console.info('[agent] likely_stt_garble', {
    snippet: text.slice(0, 100),
    orgId: organizationId,
  });
}

function mergeTranscriptLines(parts: TranscriptLine[]): string | null {
  if (parts.length === 0) return null;
  const sorted = [...parts].sort((a, b) => a.at - b.at || a.seq - b.seq);
  let text = sorted.map((p) => p.line).join('\n\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[Transcript truncated for storage.]`;
  }
  return text;
}

type RoutingHint = { slug?: string; phone?: string };

function parseMetadataRouting(metadata: string): RoutingHint {
  if (!metadata.trim()) return {};
  try {
    const p = JSON.parse(metadata) as Record<string, unknown>;
    const slugRaw = p.organization_slug ?? p.salon_slug ?? p.slug;
    const slug = typeof slugRaw === 'string' ? slugRaw.trim() : undefined;
    const phoneRaw =
      p.phone_number ?? p.dialedNumber ?? p.trunkPhoneNumber ?? p.trunk_phone_number;
    const phone = typeof phoneRaw === 'string' ? phoneRaw.trim() : undefined;
    const hint: RoutingHint = {};
    if (slug) hint.slug = slug;
    if (phone) hint.phone = phone;
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
  if (slug) hint.slug = slug;
  if (phone) hint.phone = phone;
  return hint;
}

function resolveOrgRouting(job: JobContext['job'], participant: RemoteParticipant): RoutingHint {
  const jobM = parseMetadataRouting(job.metadata ?? '');
  const roomM = job.room?.metadata ? parseMetadataRouting(job.room.metadata) : {};
  const part = routingFromParticipantAttributes(participant.attributes);

  const slug =
    jobM.slug ??
    roomM.slug ??
    part.slug ??
    process.env.DEFAULT_ORG_SLUG?.trim() ??
    process.env.DEFAULT_SALON_SLUG?.trim() ??
    undefined;

  const phone =
    part.phone ??
    jobM.phone ??
    roomM.phone ??
    process.env.DEFAULT_ORG_PHONE?.trim() ??
    process.env.DEFAULT_SALON_PHONE?.trim() ??
    DEFAULT_TEST_PHONE;

  const hint: RoutingHint = {};
  if (slug) hint.slug = slug;
  hint.phone = phone;
  return hint;
}

function callerNumberFromParticipant(participant: RemoteParticipant): string {
  const id = (participant.identity ?? '').trim();
  if (id.toLowerCase().startsWith('sip_')) {
    const rest = id.slice(4).trim();
    if (rest.startsWith('+')) return rest;
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
  if (t.startsWith('+')) return t;
  const d = t.replace(/\D/g, '');
  if (d.length >= 10) return `+${d}`;
  const fromIdentity = id.replace(/\D/g, '');
  if (fromIdentity.length >= 10) return `+${fromIdentity}`;
  return id || 'unknown';
}

function resolveCalledNumber(
  routingPhone: string | undefined,
  orgPhone: string | null | undefined,
): string {
  return routingPhone?.trim() || orgPhone?.trim() || '';
}

async function disconnectParticipant(
  roomName: string,
  identity: string,
): Promise<void> {
  const lkHost = process.env.LIVEKIT_URL?.trim();
  const lkKey = process.env.LIVEKIT_API_KEY?.trim();
  const lkSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!lkHost || !lkKey || !lkSecret || !roomName || !identity) return;
  const httpsHost = lkHost.replace(/^wss?:\/\//, 'https://');
  const client = new RoomServiceClient(httpsHost, lkKey, lkSecret);
  await client.removeParticipant(roomName, identity);
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    const routing = resolveOrgRouting(ctx.job, participant);

    const org = await getOrgForCall({
      ...(routing.slug ? { slug: routing.slug } : {}),
      ...(routing.phone ? { phone: routing.phone } : {}),
    });
    if (!org) {
      console.error('[agent] no organization for routing', {
        slug: routing.slug,
        phone: maskPhone(routing.phone),
      });
      ctx.shutdown('unknown_organization');
      return;
    }

    const gate = assertOrgCallable(org);
    if (!gate.ok) {
      console.warn('[agent] org not callable', { orgId: org.id, reason: gate.reason });
      try {
        const roomName =
          (typeof ctx.room.name === 'string' && ctx.room.name.trim()) || '';
        if (roomName && participant.identity) {
          await disconnectParticipant(roomName, participant.identity);
        }
      } catch (err) {
        console.error('[agent] org-gate disconnect failed', err);
      }
      return;
    }

    const callerNumberRaw = callerNumberFromParticipant(participant);
    const callerE164 = callerE164ForBlocklist(callerNumberRaw);
    const calledNumber =
      org.phone_number?.trim() || resolveCalledNumber(routing.phone, org.phone_number);
    const blockResult = await checkCallerBlocklist({
      organizationId: org.id,
      callerE164,
      blockAnonymous: org.block_anonymous_callers,
    });
    if (blockResult === 'blocked' || blockResult === 'lookup_failed') {
      if (blockResult === 'lookup_failed') {
        console.error('[agent] blocklist lookup failed — rejecting caller (fail closed)', {
          orgId: org.id,
        });
      } else {
        console.info('[agent] blocklist gate — rejecting caller', {
          orgId: org.id,
          callerE164: maskPhone(callerE164),
        });
      }
      await rejectBlockedCaller({
        ctx,
        participant,
        org,
        callerNumberRaw,
        callerE164,
        calledNumber,
      });
      return;
    }

    const businessFiles = await getSendableBusinessFiles(org.id);
    const caraTools = new CaraTools();
    const routingLinks = CaraTools.parseLinks(org.routing_links);

    console.info('[agent] organization loaded', {
      id: org.id,
      slug: org.slug,
      name: org.name,
      phone: maskPhone(org.phone_number),
      calledNumber: maskPhone(calledNumber),
      niche: org.niche,
      promptChars: org.custom_prompt?.length ?? 0,
      greetingSet: Boolean(org.greeting?.trim()),
      routeCount: routingLinks.length,
    });

    const custom = org.custom_prompt?.trim() || 'Be professional, concise, and helpful.';
    const now = new Date();
    const nowUtcIso = now.toISOString();
    const bookingTz = resolveOrgTimeZone(org);
    let todayLocal = nowUtcIso;
    try {
      todayLocal = now.toLocaleDateString('en-GB', {
        timeZone: bookingTz,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      /* invalid timezone */
    }

    const callerLine: CallerLineInfo = classifyCallerLine(callerNumberRaw);
    const hasCallerIdOnFile =
      callerLine.kind !== 'unknown' && Boolean(callerLine.e164);

    const elevenModelEarly =
      (process.env.ELEVEN_TTS_MODEL?.trim() || 'eleven_turbo_v2_5') as elevenlabs.TTSModels;

    const systemPrompt = buildCaraCallPrompt({
      businessName: org.name,
      customPrompt: custom,
      callerLine,
      routingLinks,
      bookingTimeZone: bookingTz,
      nowUtcIso,
      todayLocal,
      ttsModel: elevenModelEarly,
    });

    const callStartedAt = Date.now();
    const roomName =
      (typeof ctx.room.name === 'string' && ctx.room.name.trim()) ||
      (ctx.job.room && typeof (ctx.job.room as { name?: string }).name === 'string'
        ? String((ctx.job.room as { name: string }).name).trim()
        : '') ||
      '';
    const callSidAttr = stableCallSidFallback(participant, roomName);

    const billingPeriodStart = currentBillingPeriodStart(org.billing_period_start ?? null);
    const planQuota = planQuotaMinutes(org.plan_tier);

    const burstPctRaw = Number.parseFloat(process.env.CLISTE_QUOTA_BURST_PCT ?? '10');
    const burstFloor = Number.parseInt(process.env.CLISTE_QUOTA_BURST_FLOOR_MIN ?? '5', 10);
    if (typeof planQuota === 'number' && planQuota > 0) {
      const used = await sumUsageMinutesThisPeriod({
        organizationId: org.id,
        billingPeriodStart,
      });
      if (used != null) {
        const burstPct = Number.isFinite(burstPctRaw) ? burstPctRaw : 10;
        const burstAllowance = Math.max(
          Number.isFinite(burstFloor) ? burstFloor : 5,
          Math.ceil((planQuota * burstPct) / 100),
        );
        if (used >= planQuota + burstAllowance) {
          console.warn('[agent] over-quota — refusing call', {
            orgId: org.id,
            planQuota,
            used,
          });
          try {
            if (roomName && participant.identity) {
              await disconnectParticipant(roomName, participant.identity);
            }
          } catch (err) {
            console.error('[agent] over-quota disconnect failed', err);
          }
          return;
        }
      }
    }

    const usageRecordIdPromise = startUsageRecord({
      organizationId: org.id,
      planTier: org.plan_tier ?? null,
      planQuotaMinutes: planQuota,
      callSid: callSidAttr,
      roomName: roomName || null,
      callerNumber: callerNumberRaw,
      billingPeriodStart,
    });

    const endCallTarget =
      roomName && participant.identity
        ? { roomName, callerIdentity: participant.identity }
        : undefined;

    const greetingText = org.greeting?.trim() ?? '';
    const sessionUserData: CaraAgentUserData = {
      organizationId: org.id,
      businessName: org.name,
      calledNumber,
      callerPhone: callerNumberRaw,
      routingLinks,
      businessFiles,
      fallbackNumber: org.fallback_number,
      callRoutingMode: org.call_routing_mode,
      sessionFlags: {
        linkSent: false,
        actionTicketCreated: false,
        callbackRequested: false,
        smsSent: 0,
        endPhoneCallUsed: false,
        askedAnythingElse: false,
        awaitingAnythingElseReply: false,
        anythingElseAskCount: 0,
        callerRespondedAfterAnythingElse: false,
        bookingLinkConsentPending: false,
        bookingLinkConsentGranted: false,
        bookingRouteId: null,
        bookingLinkSendInFlight: false,
        userTurnsSinceBookingOffer: 0,
        closingCall: false,
        bookingSmsAutoSendStarted: false,
        bookingLinkConsentOfferSpoken: false,
        likelySttGarble: false,
        bookingSendConfirmedSpoken: false,
        assistantClaimedLinkSentSpoken: false,
      },
      disclosureConfirmed: greetingIncludesAiDisclosure(greetingText),
      ...(endCallTarget ? { endCallTarget } : {}),
    };

    const elevenApiKey =
      process.env.ELEVEN_API_KEY?.trim() || process.env.ELEVENLABS_API_KEY?.trim() || '';
    if (!elevenApiKey) {
      console.error('[agent] ELEVENLABS_API_KEY (or ELEVEN_API_KEY) is required — ElevenLabs-only TTS');
      ctx.shutdown('missing_elevenlabs_key');
      return;
    }

    const inferenceSttModel =
      process.env.LIVEKIT_INFERENCE_STT_MODEL?.trim() || 'assemblyai/u3-rt-pro';
    const inferenceSttLanguage = process.env.LIVEKIT_INFERENCE_STT_LANGUAGE?.trim() || 'en';
    const inferenceLlmModel =
      process.env.LIVEKIT_INFERENCE_LLM_MODEL?.trim() || 'openai/gpt-4.1';
    const useDirectOpenAiLlm =
      process.env.CARA_LLM_PROVIDER?.trim().toLowerCase() === 'openai' &&
      !!process.env.OPENAI_API_KEY?.trim();

    const elevenVoiceId =
      resolveOrgVoiceId(org) || process.env.ELEVEN_VOICE_ID?.trim() || 'C92s6vssSLlabgIln1iY';
    const elevenModel = elevenModelEarly;
    const elevenEncoding = process.env.ELEVEN_TTS_ENCODING?.trim() || 'pcm_24000';
    const elevenBaseUrl =
      process.env.ELEVENLABS_BASE_URL?.trim() || 'https://api.elevenlabs.io/v1';

    const useSttNeuralTurnDetection = isU3RtProSttModel(inferenceSttModel);
    const latencyProfile = resolveSttLatencyProfile(process.env.LIVEKIT_STT_LATENCY_PROFILE);
    const silenceDefaults = sttTurnSilenceDefaults(latencyProfile);
    const endpointDefaults = endpointingDefaults(latencyProfile, useSttNeuralTurnDetection);

    const endpointMinMs = Number.isFinite(
      Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MIN_MS ?? '', 10),
    )
      ? Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MIN_MS ?? '', 10)
      : endpointDefaults.minDelayMs;
    const endpointMaxMs = Number.isFinite(
      Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MAX_MS ?? '', 10),
    )
      ? Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MAX_MS ?? '', 10)
      : endpointDefaults.maxDelayMs;
    const endpointMode = (process.env.LIVEKIT_ENDPOINTING_MODE?.trim() || 'dynamic') as
      | 'fixed'
      | 'dynamic';
    const useTurnDetector =
      !useSttNeuralTurnDetection &&
      (process.env.LIVEKIT_USE_TURN_DETECTOR?.trim().toLowerCase() || 'on') !== 'off';

    let turnDetectorInstance: InstanceType<typeof lkTurn.turnDetector.EnglishModel> | null = null;
    if (useTurnDetector) {
      try {
        turnDetectorInstance = new lkTurn.turnDetector.EnglishModel();
      } catch (err) {
        console.error('[agent] turn-detector init failed — VAD/STT fallback', err);
      }
    }

    const interruptionMinMs = Number.parseInt(process.env.LIVEKIT_INTERRUPTION_MIN_MS ?? '200', 10);
    const interruptionMinWords = Number.parseInt(process.env.LIVEKIT_INTERRUPTION_MIN_WORDS ?? '1', 10);
    const interruptionModeRaw = process.env.LIVEKIT_INTERRUPTION_MODE?.trim().toLowerCase();
    const interruptionMode: 'adaptive' | 'vad' | undefined =
      interruptionModeRaw === 'vad' ? 'vad' : interruptionModeRaw === 'auto' ? undefined : 'adaptive';

    const envExtraKeyterms =
      process.env.LIVEKIT_STT_EXTRA_KEYTERMS?.split(/[,;]+/)
        .map((s) => s.trim())
        .filter((w) => w.length > 1) ?? [];
    const sttKeyterms = buildSttKeyterms({
      orgName: org.name,
      customPrompt: org.custom_prompt,
      extraTerms: envExtraKeyterms,
    });
    const sttDomainPrompt =
      process.env.LIVEKIT_STT_DOMAIN_PROMPT?.trim() || buildSttDomainPrompt(org.name);
    const sttMinTurnSilenceMs = Number.isFinite(
      Number.parseInt(process.env.LIVEKIT_STT_MIN_TURN_SILENCE_MS ?? '', 10),
    )
      ? Number.parseInt(process.env.LIVEKIT_STT_MIN_TURN_SILENCE_MS ?? '', 10)
      : silenceDefaults.minTurnSilenceMs;
    const sttMaxTurnSilenceMs = Number.isFinite(
      Number.parseInt(process.env.LIVEKIT_STT_MAX_TURN_SILENCE_MS ?? '', 10),
    )
      ? Number.parseInt(process.env.LIVEKIT_STT_MAX_TURN_SILENCE_MS ?? '', 10)
      : silenceDefaults.maxTurnSilenceMs;
    const sttEotConfidence = Number.isFinite(
      Number.parseFloat(process.env.LIVEKIT_STT_EOT_CONFIDENCE ?? ''),
    )
      ? Number.parseFloat(process.env.LIVEKIT_STT_EOT_CONFIDENCE ?? '')
      : silenceDefaults.eotConfidence;

    // 0.55 adds phrasing variety; >0.6 risks rule-breaking — validate on 5+ test calls.
    const llmTemperature = Number.parseFloat(process.env.LIVEKIT_LLM_TEMPERATURE ?? '0.55');
    const llmMaxCompletionTokens = Number.parseInt(process.env.LIVEKIT_LLM_MAX_TOKENS ?? '120', 10);

    const sttModelOptions = isAssemblyAiSttModel(inferenceSttModel)
      ? buildAssemblyAiSttOptions({
          model: inferenceSttModel,
          keyterms: sttKeyterms,
          domainPrompt: sttDomainPrompt,
          minTurnSilenceMs: sttMinTurnSilenceMs,
          maxTurnSilenceMs: sttMaxTurnSilenceMs,
          eotConfidence: sttEotConfidence,
        })
      : {
          interim_results: true,
          ...(sttKeyterms.length > 0 ? { keyterms: sttKeyterms } : {}),
        };

    const directOpenAiLlmModel = inferenceLlmModel.replace(/^openai\//, '');
    const llmInstance = useDirectOpenAiLlm
      ? new openai.LLM({
          apiKey: process.env.OPENAI_API_KEY?.trim() ?? '',
          model: directOpenAiLlmModel,
          temperature: llmTemperature,
          maxCompletionTokens: llmMaxCompletionTokens,
        })
      : new inference.LLM({
          model: inferenceLlmModel as inference.LLMModels,
          modelOptions: {
            temperature: llmTemperature,
            max_completion_tokens: llmMaxCompletionTokens,
          },
        });

    console.info('[agent] pipeline', {
      stt: inferenceSttModel,
      sttKeytermCount: sttKeyterms.length,
      sttNeuralTurn: useSttNeuralTurnDetection,
      latencyProfile,
      sttMinTurnSilenceMs,
      sttMaxTurnSilenceMs,
      sttEotConfidence,
      endpointMinMs,
      endpointMaxMs,
      llm: useDirectOpenAiLlm ? `openai-direct:${directOpenAiLlmModel}` : inferenceLlmModel,
      tts: `elevenlabs:${elevenModel}`,
    });

    setActiveTtsModelForSanitizer(elevenModel);

    const session = new voice.AgentSession<CaraAgentUserData>({
      stt: new inference.STT({
        model: inferenceSttModel,
        language: inferenceSttLanguage,
        modelOptions: sttModelOptions,
      }),
      vad: ctx.proc.userData.vad as silero.VAD,
      llm: llmInstance,
      tts: createElevenLabsTts({
        apiKey: elevenApiKey,
        voiceId: elevenVoiceId,
        model: elevenModel,
        encoding: elevenEncoding as elevenlabs.TTSEncoding,
        baseURL: elevenBaseUrl,
        streamingLatency: Number.parseInt(process.env.ELEVEN_STREAMING_LATENCY ?? '0', 10) || 0,
        voiceSettings: resolveElevenVoiceSettings(),
      }),
      userData: sessionUserData,
      maxToolSteps: 5,
      turnHandling: {
        preemptiveGeneration: {
          enabled:
            process.env.LIVEKIT_PREEMPTIVE_GENERATION?.trim().toLowerCase() === 'true',
        },
        turnDetection: turnDetectorInstance ?? 'stt',
        endpointing: {
          mode: endpointMode,
          minDelay: endpointMinMs,
          maxDelay: endpointMaxMs,
        },
        interruption: {
          mode: interruptionMode,
          discardAudioIfUninterruptible:
            process.env.LIVEKIT_DISCARD_AUDIO_IF_UNINTERRUPTIBLE?.trim().toLowerCase() === 'true',
          minDuration: Number.isFinite(interruptionMinMs) ? interruptionMinMs : 200,
          minWords: Number.isFinite(interruptionMinWords) ? interruptionMinWords : 1,
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
      console.error('[AgentSession] pipeline error', msg);
    });

    const silenceRecoveryDelayMs = Number.parseInt(process.env.LIVEKIT_SILENCE_RECOVERY_MS ?? '550', 10);
    const silenceRecoveryMaxPerCall = Number.parseInt(
      process.env.LIVEKIT_SILENCE_RECOVERY_MAX_PER_CALL ?? '5',
      10,
    );
    const deadAirMs = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_MS ?? '10000', 10);
    const deadAirCloseMs = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_CLOSE_MS ?? '8000', 10);
    const deadAirMaxPrompts = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_MAX_PROMPTS ?? '2', 10);
    const responseFillerMs = Number.parseInt(process.env.LIVEKIT_RESPONSE_FILLER_MS ?? '1200', 10);
    const responseFillerMaxPerCall = Number.parseInt(
      process.env.LIVEKIT_RESPONSE_FILLER_MAX_PER_CALL ?? '3',
      10,
    );
    const thinkingStuckMs = Number.parseInt(process.env.LIVEKIT_THINKING_STUCK_MS ?? '2500', 10);
    const qaThinkingAckMs = Number.parseInt(process.env.LIVEKIT_QA_THINKING_ACK_MS ?? '3000', 10);
    const postGreetingGraceMs = Number.parseInt(
      process.env.LIVEKIT_POST_GREETING_GRACE_MS ?? '5000',
      10,
    );
    const backchannelsEnabled =
      process.env.LIVEKIT_BACKCHANNELS?.trim().toLowerCase() === 'on';
    const backchannelMinIntervalMs = Number.parseInt(
      process.env.LIVEKIT_BACKCHANNEL_MIN_MS ?? '6000',
      10,
    );
    let silenceRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let silenceRecoveryCount = 0;
    let fakeHangupGuardTimer: ReturnType<typeof setTimeout> | null = null;
    let goodbyeForceTimer: ReturnType<typeof setTimeout> | null = null;
    let deadAirTimer: ReturnType<typeof setTimeout> | null = null;
    let deadAirCloseTimer: ReturnType<typeof setTimeout> | null = null;
    let deadAirPromptCount = 0;
    let responseFillerTimer: ReturnType<typeof setTimeout> | null = null;
    let responseFillerCount = 0;
    let callerInterimPauseTimer: ReturnType<typeof setTimeout> | null = null;
    let lastBackchannelAt = 0;
    let lastCallerInterimAt = 0;
    let thinkingStuckTimer: ReturnType<typeof setTimeout> | null = null;
    let thinkingStuckRecoveryUsedForTurn = false;
    let qaThinkingAckTimer: ReturnType<typeof setTimeout> | null = null;
    let qaThinkingAckUsedForTurn = false;
    let emptySpeechFallbackUsedForTurn = false;
    let emptySpeechCountForTurn = 0;
    let emptySpeechCircuitBreakerUsedForCall = false;
    let callerAwaitingReply = false;
    let replyTurnEpoch = 0;
    let generateReplyInFlight = false;
    let allowBookingAutomation = false;
    let greetingPlaybackStarted = false;
    let greetingAudioSpeechPending = 0;
    let listenGraceUntil = 0;
    let callerHasFinalTranscript = false;
    let lastAssistantChatText = '';

    let thinkingStartedAt: number | null = null;
    let userStoppedSpeakingAt: number | null = null;
    let bookingConsentAtMs = 0;
    let bookingConsentOfferedAtMs = 0;

    const transcriptParts: TranscriptLine[] = [];
    let transcriptSeq = 0;
    const recentCallerTranscriptKeys = new Set<string>();

    const normalizeTranscriptKey = (text: string) =>
      text.trim().toLowerCase().replace(/\s+/g, ' ');

    const appendTranscriptLine = (at: number, line: string) => {
      transcriptParts.push({ at, seq: transcriptSeq++, line });
    };

    const assistantSpokeSinceBookingConsent = (pattern: RegExp): boolean =>
      transcriptParts.some(
        (p) =>
          p.line.startsWith('Assistant:') &&
          p.at >= bookingConsentOfferedAtMs &&
          pattern.test(p.line),
      );

    const hasCallerTranscript = () =>
      transcriptParts.some((p) => p.line.startsWith('Caller:'));

    const inListenGrace = () =>
      listenGraceUntil > 0 && Date.now() < listenGraceUntil;

    const bumpReplyTurn = (reason: string) => {
      replyTurnEpoch += 1;
      generateReplyInFlight = false;
      emptySpeechCountForTurn = 0;
      emptySpeechFallbackUsedForTurn = false;
      listenGraceUntil = 0;
      callerHasFinalTranscript = true;
      console.info('[agent] reply_turn_bump', { epoch: replyTurnEpoch, reason });
    };

    const safeGenerateReply = (instructions: string, opts?: { force?: boolean }) => {
      const epoch = replyTurnEpoch;
      if (generateReplyInFlight && !opts?.force) {
        console.warn('[agent] generateReply_suppressed — single-flight', { epoch });
        return;
      }
      generateReplyInFlight = true;
      const handle = session.generateReply({ instructions });
      // SpeechHandle is thenable (has .then) but not a Promise — wrap before .catch/.finally.
      void Promise.resolve(handle)
        .catch((e) => {
          console.error('[AgentSession] generateReply failed', e);
        })
        .finally(() => {
          if (epoch === replyTurnEpoch) {
            generateReplyInFlight = false;
          }
        });
    };

    const settleGreetingPhase = (reason: string) => {
      if (allowBookingAutomation) return;
      allowBookingAutomation = true;
      if (postGreetingGraceMs > 0) {
        listenGraceUntil = Date.now() + postGreetingGraceMs;
      }
      console.info('[agent] greeting_phase_settled', {
        reason,
        listenGraceMs: postGreetingGraceMs,
      });
    };

    const canPlayRecoverySpeech = (): boolean => {
      if (isCallEnding()) return false;
      if (session.userState === 'speaking') return false;
      if (lastCallerInterimAt > 0 && Date.now() - lastCallerInterimAt < 2000) return false;
      if (inListenGrace()) return false;
      return true;
    };

    const deterministicEmptySpeechFallback = () => {
      if (emptySpeechCircuitBreakerUsedForCall || !canPlayRecoverySpeech()) return;
      emptySpeechCircuitBreakerUsedForCall = true;
      const lastCaller = [...transcriptParts]
        .reverse()
        .find((p) => p.line.startsWith('Caller:'));
      const snippet = lastCaller?.line.replace(/^Caller:\s*/, '') ?? '';
      if (
        soundsLikeBookingIntent(snippet) ||
        /\b(haircut|colour|color|lash|nail|book|appointment)\b/i.test(snippet)
      ) {
        sayPrepared(session, 'Sorry about that — what service were you looking to book?');
        return;
      }
      if (callerAskedPhoneOrHumanBooking(snippet)) {
        sayPrepared(
          session,
          'We take bookings online, or I can pass your details to the team for a callback.',
        );
        return;
      }
      if (!snippet) {
        sayPrepared(session, 'What can I help you with today?');
        return;
      }
      sayPrepared(session, 'Sorry about that — how can I help?');
    };

    const speakBookingConfirmationOnce = async () => {
      const flags = session.userData.sessionFlags;
      if (flags.bookingSendConfirmedSpoken) return;

      if (session.agentState === 'speaking') {
        await waitForSessionPlayout(session);
      }
      await new Promise((r) => setTimeout(r, 400));

      if (flags.bookingSendConfirmedSpoken) return;

      const saidSent = assistantSpokeSinceBookingConsent(
        /\b(that'?s sent|sent now|texted you|i'?ve texted)\b/i,
      );
      const saidAnythingElse = assistantSpokeSinceBookingConsent(/\banything else\b/i);
      if (saidSent && saidAnythingElse) {
        flags.bookingSendConfirmedSpoken = true;
        flags.askedAnythingElse = true;
        flags.awaitingAnythingElseReply = true;
        flags.callerRespondedAfterAnythingElse = false;
        return;
      }
      flags.bookingSendConfirmedSpoken = true;
      if (saidSent) {
        sayPrepared(session, 'Is there anything else I can help with?');
        flags.askedAnythingElse = true;
        flags.awaitingAnythingElseReply = true;
        flags.anythingElseAskCount += 1;
        flags.callerRespondedAfterAnythingElse = false;
        return;
      }
      sayPrepared(session, "That's sent now — is there anything else I can help with?");
      flags.askedAnythingElse = true;
      flags.awaitingAnythingElseReply = true;
      flags.anythingElseAskCount += 1;
      flags.callerRespondedAfterAnythingElse = false;
    };

    const resetClosePhaseIfCallerContinues = (text: string) => {
      const flags = session.userData.sessionFlags;
      if (!flags.askedAnythingElse && !flags.awaitingAnythingElseReply) return;
      if (callerSaidNothingElse(text)) return;
      if (callerAskedNewQuestion(text) || text.trim().length > 10) {
        flags.askedAnythingElse = false;
        flags.awaitingAnythingElseReply = false;
        flags.callerRespondedAfterAnythingElse = false;
      }
    };

    const isCallEnding = () => {
      const f = session.userData.sessionFlags;
      return f.endPhoneCallUsed || f.closingCall;
    };

    const shouldSuppressFillers = () => {
      const f = session.userData.sessionFlags;
      return (
        isCallEnding() ||
        f.awaitingAnythingElseReply ||
        f.bookingLinkSendInFlight ||
        f.bookingSmsAutoSendStarted
      );
    };

    const noteCallerTurnNeedsReply = (text: string) => {
      if (
        text.length > 12 ||
        callerAskedNewQuestion(text) ||
        callerPivotedFromSmsConsent(text) ||
        callerAskedPhoneOrHumanBooking(text)
      ) {
        callerAwaitingReply = true;
      }
    };

    const handleBookingConsentCallerTurn = (text: string) => {
      const flags = session.userData.sessionFlags;
      if (!flags.bookingLinkConsentPending) return;
      flags.userTurnsSinceBookingOffer += 1;

      if (callerDeclinedSmsConsent(text)) {
        flags.bookingLinkConsentPending = false;
        flags.bookingLinkConsentGranted = false;
        callerAwaitingReply = false;
        clearThinkingStuckTimer();
        thinkingStuckRecoveryUsedForTurn = true;
        void safeGenerateReply(
          'Caller declined the text booking link. One turn: "No bother — I\'ll get the team to sort that for you." Ask first name only. Do NOT repeat the service name or re-offer the link. After name, takeCallbackMessage.',
        );
        return;
      }

      if (
        callerPivotedFromSmsConsent(text) ||
        callerAskedPhoneOrHumanBooking(text) ||
        (callerAskedNewQuestion(text) && !callerGrantedSmsConsent(text))
      ) {
        flags.bookingLinkConsentPending = false;
        flags.bookingLinkConsentGranted = false;
        clearThinkingStuckTimer();
        thinkingStuckRecoveryUsedForTurn = false;
        const phonePivot = callerAskedPhoneOrHumanBooking(text);
        safeGenerateReply(
          phonePivot
            ? 'Caller asked to book over the phone or speak to a team member. One short turn: appointment times are booked online, or you can leave details for a team callback — you cannot lock in a slot on this call. Ask first name only if they want a callback. Do NOT re-offer the SMS link unless they ask for it.'
            : 'Caller did not give a clear yes or no on the SMS link — they asked something else. Answer their question directly in one or two sentences. Do NOT repeat the full booking link consent pitch.',
        );
        return;
      }

      if (callerGrantedSmsConsent(text)) {
        flags.bookingLinkConsentGranted = true;
      }
      maybeAutoSendBookingLink(text);
      if (
        !callerGrantedSmsConsent(text) &&
        soundsLikeCallerLineCheck(text) &&
        flags.userTurnsSinceBookingOffer > 0
      ) {
        safeGenerateReply(
          'Caller is checking you are still on the line while waiting for SMS consent. One short line only: still here. Then ask "Shall I text you that link — just say yes or no?" Do NOT repeat the service summary or full booking pitch.',
        );
      }
    };

    const maybeAutoSendBookingLink = (consentText: string) => {
      const flags = session.userData.sessionFlags;
      if (!flags.bookingLinkConsentPending) return;
      if (flags.userTurnsSinceBookingOffer < 1) return;
      if (session.agentState === 'speaking') return;
      if (bookingConsentOfferedAtMs > 0 && Date.now() - bookingConsentOfferedAtMs < 1500) {
        return;
      }
      if (!callerGrantedSmsConsent(consentText)) return;
      if (!flags.bookingRouteId || flags.linkSent || flags.bookingSmsAutoSendStarted) return;

      console.info('[agent] booking_sms_auto_send', {
        snippet: consentText.slice(0, 120),
        turnsSinceOffer: flags.userTurnsSinceBookingOffer,
      });

      flags.bookingSmsAutoSendStarted = true;
      flags.bookingLinkConsentGranted = true;
      flags.bookingLinkConsentPending = false;
      bookingConsentAtMs = Date.now();
      scheduleResponseFillerForSlowWork();
      const routeId = flags.bookingRouteId;
      void (async () => {
        try {
          const result = await sendBookingLinkSmsForRoute(session.userData, routeId);
          if (result.ok) {
            await speakBookingConfirmationOnce();
          } else {
            flags.bookingSmsAutoSendStarted = false;
            sayPrepared(
              session,
              "Sorry, I couldn't text the booking link just now — I'll pass your details to the team.",
            );
          }
        } catch (e) {
          flags.bookingSmsAutoSendStarted = false;
          console.error('[AgentSession] auto booking SMS failed', e);
        }
      })();
    };

    const maybeCloseAfterAnythingElse = (text: string) => {
      const flags = session.userData.sessionFlags;
      if (!flags.askedAnythingElse || !callerSaidNothingElse(text)) return;
      if (flags.bookingLinkConsentPending || flags.bookingSmsAutoSendStarted) return;
      if (flags.endPhoneCallUsed || flags.closingCall) return;

      flags.callerRespondedAfterAnythingElse = true;
      flags.closingCall = true;
      clearAllGuardTimers();
      void (async () => {
        try {
          sayPrepared(session, `Lovely, thanks for calling ${org.name}. Bye!`);
          await waitForSessionPlayout(session);
          await disconnectCallerLeg(session, session.userData, async () => {});
        } catch (e) {
          console.error('[AgentSession] auto close after anything-else failed', e);
        }
      })();
    };

    const markBookingConsentOffered = () => {
      const flags = session.userData.sessionFlags;
      if (
        flags.bookingLinkConsentOfferSpoken ||
        flags.bookingSmsAutoSendStarted ||
        flags.linkSent ||
        flags.bookingLinkConsentGranted
      ) {
        return;
      }
      flags.bookingLinkConsentOfferSpoken = true;
      flags.bookingLinkConsentPending = true;
      flags.bookingLinkConsentGranted = false;
      flags.userTurnsSinceBookingOffer = 0;
      bookingConsentOfferedAtMs = Date.now();
    };

    const gracefulDisconnect = () => {
      void disconnectCallerLeg(session, session.userData, () => waitForSessionPlayout(session));
    };

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
    const clearGoodbyeForceTimer = () => {
      if (goodbyeForceTimer) {
        clearTimeout(goodbyeForceTimer);
        goodbyeForceTimer = null;
      }
    };
    const clearDeadAirTimers = () => {
      if (deadAirTimer) {
        clearTimeout(deadAirTimer);
        deadAirTimer = null;
      }
      if (deadAirCloseTimer) {
        clearTimeout(deadAirCloseTimer);
        deadAirCloseTimer = null;
      }
    };

    const clearResponseFillerTimer = () => {
      if (responseFillerTimer) {
        clearTimeout(responseFillerTimer);
        responseFillerTimer = null;
      }
    };
    const clearCallerInterimPauseTimer = () => {
      if (callerInterimPauseTimer) {
        clearTimeout(callerInterimPauseTimer);
        callerInterimPauseTimer = null;
      }
    };

    const canPlayResponseFiller = (): boolean => {
      if (responseFillerMs <= 0) return false;
      if (responseFillerCount >= responseFillerMaxPerCall) return false;
      if (isCallEnding()) return false;
      if (shouldSuppressFillers()) return false;
      if (session.agentState === 'speaking') return false;
      return true;
    };

    const scheduleResponseFillerForSlowWork = () => {
      clearResponseFillerTimer();
      if (responseFillerMs <= 0 || shouldSuppressFillers() || isCallEnding()) return;
      responseFillerTimer = setTimeout(() => {
        responseFillerTimer = null;
        if (!canPlayResponseFiller()) return;
        responseFillerCount += 1;
        const phrase =
          RESPONSE_FILLER_PHRASES[
            (responseFillerCount - 1) % RESPONSE_FILLER_PHRASES.length
          ]!;
        sayPrepared(session, phrase);
      }, responseFillerMs);
    };

    const clearThinkingStuckTimer = () => {
      if (thinkingStuckTimer) {
        clearTimeout(thinkingStuckTimer);
        thinkingStuckTimer = null;
      }
    };

    const clearQaThinkingAckTimer = () => {
      if (qaThinkingAckTimer) {
        clearTimeout(qaThinkingAckTimer);
        qaThinkingAckTimer = null;
      }
    };

    const scheduleThinkingStuckRecovery = () => {
      clearThinkingStuckTimer();
      if (thinkingStuckMs <= 0 || isCallEnding() || shouldSuppressFillers()) return;
      if (session.userState === 'speaking') return;
      if (inListenGrace() && !callerHasFinalTranscript) return;
      thinkingStuckTimer = setTimeout(() => {
        thinkingStuckTimer = null;
        if (session.agentState !== 'thinking' || thinkingStuckRecoveryUsedForTurn) return;
        if (session.userState === 'speaking') return;
        if (inListenGrace() && !callerHasFinalTranscript) return;
        thinkingStuckRecoveryUsedForTurn = true;
        console.warn('[agent] thinking_stuck_recovery', { afterMs: thinkingStuckMs });
        safeGenerateReply(
          'The caller is waiting on the line after their last message. Reply in one or two short sentences — acknowledge what they asked for. No long service menus.',
        );
      }, thinkingStuckMs);
    };

    const scheduleQaThinkingAck = () => {
      clearQaThinkingAckTimer();
      if (qaThinkingAckMs <= 0 || isCallEnding() || shouldSuppressFillers()) return;
      if (inListenGrace() && !callerHasFinalTranscript) return;
      qaThinkingAckTimer = setTimeout(() => {
        qaThinkingAckTimer = null;
        if (session.agentState !== 'thinking' || qaThinkingAckUsedForTurn) return;
        if (shouldSuppressFillers() || isCallEnding()) return;
        if (session.userState === 'speaking' || !canPlayRecoverySpeech()) return;
        qaThinkingAckUsedForTurn = true;
        sayPrepared(session, 'Let me see now…', { addToChatCtx: false, allowInterruptions: false });
      }, qaThinkingAckMs);
    };

    const clearAllGuardTimers = () => {
      clearSilenceRecoveryTimer();
      clearFakeHangupGuardTimer();
      clearGoodbyeForceTimer();
      clearDeadAirTimers();
      clearResponseFillerTimer();
      clearCallerInterimPauseTimer();
      clearThinkingStuckTimer();
      clearQaThinkingAckTimer();
    };

    const resetDeadAirTimer = () => {
      clearDeadAirTimers();
      if (isCallEnding()) return;
      const f = session.userData.sessionFlags;
      if (f.askedAnythingElse && f.callerRespondedAfterAnythingElse) return;
      if (f.bookingLinkSendInFlight || f.bookingSmsAutoSendStarted) return;
      if (callerAwaitingReply) return;
      if (inListenGrace()) return;
      deadAirTimer = setTimeout(() => {
        deadAirTimer = null;
        try {
          if (isCallEnding()) return;
          if (callerAwaitingReply) return;
          if (inListenGrace()) return;
          if (session.agentState !== 'listening' || session.userState === 'speaking') return;
          if (deadAirPromptCount >= deadAirMaxPrompts) {
            gracefulDisconnect();
            return;
          }
          deadAirPromptCount += 1;
          sayPrepared(session, 'Sorry — are you still there?');
          deadAirCloseTimer = setTimeout(() => {
            deadAirCloseTimer = null;
            try {
              if (isCallEnding()) return;
              if (session.agentState !== 'listening' || session.userState === 'speaking') return;
              gracefulDisconnect();
            } catch (e) {
              console.error('[AgentSession] dead-air close failed', e);
            }
          }, deadAirCloseMs);
        } catch (e) {
          console.error('[AgentSession] dead-air prompt failed', e);
        }
      }, deadAirMs);
    };

    const scheduleSilenceRecoveryAfterCutoff = () => {
      if (isCallEnding() || shouldSuppressFillers()) return;
      clearSilenceRecoveryTimer();
      silenceRecoveryTimer = setTimeout(() => {
        silenceRecoveryTimer = null;
        try {
          if (isCallEnding()) return;
          if (session.userState === 'speaking' || session.agentState !== 'listening') return;
          if (silenceRecoveryCount >= silenceRecoveryMaxPerCall) return;
          silenceRecoveryCount += 1;
          void safeGenerateReply(
            'Your previous reply may not have played. One short warm line — sorry about that — then continue where you left off. If you already asked to send the booking link, do NOT offer it again — wait for their yes or no.',
          );
        } catch (e) {
          console.error('[AgentSession] silence recovery failed', e);
        }
      }, silenceRecoveryDelayMs);
    };

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      resetDeadAirTimer();
      if (ev.oldState === 'speaking' && ev.newState === 'listening') {
        userStoppedSpeakingAt = Date.now();
      }
      if (ev.newState === 'speaking') {
        thinkingStuckRecoveryUsedForTurn = false;
        emptySpeechFallbackUsedForTurn = false;
        clearSilenceRecoveryTimer();
        userStoppedSpeakingAt = null;
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState === 'speaking' || ev.newState === 'listening') {
        clearResponseFillerTimer();
        clearThinkingStuckTimer();
        clearQaThinkingAckTimer();
      }
      if (ev.newState === 'speaking') {
        if (thinkingStartedAt !== null) {
          console.info('[agent] thinking_to_speaking_ms', Date.now() - thinkingStartedAt);
          thinkingStartedAt = null;
        }
        qaThinkingAckUsedForTurn = false;
      } else if (ev.newState === 'thinking' && !isCallEnding()) {
        if (userStoppedSpeakingAt !== null) {
          console.info(
            '[agent] user_speaking_to_thinking_ms',
            Date.now() - userStoppedSpeakingAt,
          );
          userStoppedSpeakingAt = null;
        }
        thinkingStartedAt = Date.now();
        thinkingStuckRecoveryUsedForTurn = false;
        qaThinkingAckUsedForTurn = false;
        scheduleThinkingStuckRecovery();
        scheduleQaThinkingAck();
      }
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      resetDeadAirTimer();
      const speechEpoch = replyTurnEpoch;
      if (!greetingPlaybackStarted) {
        greetingPlaybackStarted = true;
      }
      ev.speechHandle.addDoneCallback((sh) => {
        if (speechEpoch !== replyTurnEpoch) {
          console.info('[agent] stale_speech_ignored', {
            speechEpoch,
            replyTurnEpoch,
            interrupted: sh.interrupted,
          });
          return;
        }
        if (sh.interrupted) {
          scheduleSilenceRecoveryAfterCutoff();
          if (!allowBookingAutomation) {
            settleGreetingPhase('greeting_interrupted');
          }
        } else if (!allowBookingAutomation) {
          settleGreetingPhase('greeting_completed');
        }
        const handle = sh as unknown as { text?: string; source?: string };
        const spoken =
          typeof handle.text === 'string'
            ? handle.text
            : typeof handle.source === 'string'
              ? handle.source
              : '';
        if (!spoken.trim()) {
          if (greetingAudioSpeechPending > 0) {
            greetingAudioSpeechPending -= 1;
            return;
          }
          // SpeechHandle text/source can be empty even when TTS played; chat ctx has the line.
          if (lastAssistantChatText.trim()) {
            lastAssistantChatText = '';
            return;
          }
          emptySpeechCountForTurn += 1;
          console.warn('[agent] empty_speech_handle', {
            count: emptySpeechCountForTurn,
            userState: session.userState,
            agentState: session.agentState,
            hasCallerTranscript: hasCallerTranscript(),
            inListenGrace: inListenGrace(),
            lastAssistantSnippet: lastAssistantChatText.slice(0, 80),
          });
          if (
            emptySpeechCountForTurn >= 2 &&
            !emptySpeechCircuitBreakerUsedForCall &&
            canPlayRecoverySpeech()
          ) {
            console.error('[agent] empty_speech_circuit_breaker');
            deterministicEmptySpeechFallback();
            return;
          }
          if (!inListenGrace() || callerHasFinalTranscript) {
            scheduleThinkingStuckRecovery();
          }
          if (
            !emptySpeechFallbackUsedForTurn &&
            canPlayRecoverySpeech() &&
            !emptySpeechCircuitBreakerUsedForCall
          ) {
            emptySpeechFallbackUsedForTurn = true;
            sayPrepared(session, 'Sorry — one sec.', { addToChatCtx: false });
          }
          return;
        }
        if (lastAssistantChatText.trim()) {
          lastAssistantChatText = '';
        }
        if (assistantOfferedBookingLinkConsent(spoken)) {
          const flags = session.userData.sessionFlags;
          if (flags.bookingLinkConsentOfferSpoken) {
            console.warn('[agent] duplicate_consent_speech_ignored');
          } else {
            markBookingConsentOffered();
          }
        }
      });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (backchannelsEnabled && !ev.isFinal && ev.transcript?.trim()) {
        lastCallerInterimAt = Date.now();
        if (
          !isCallEnding() &&
          !shouldSuppressFillers() &&
          session.agentState === 'listening' &&
          session.userState === 'speaking'
        ) {
          clearCallerInterimPauseTimer();
          callerInterimPauseTimer = setTimeout(() => {
            callerInterimPauseTimer = null;
            try {
              if (!backchannelsEnabled || isCallEnding() || shouldSuppressFillers()) return;
              if (session.agentState !== 'listening' || session.userState !== 'speaking') {
                return;
              }
              if (Date.now() - lastBackchannelAt < backchannelMinIntervalMs) return;
              if (Date.now() - lastCallerInterimAt < 650) return;
              lastBackchannelAt = Date.now();
              sayPrepared(session, 'mm-hmm', { addToChatCtx: false, allowInterruptions: false });
            } catch (e) {
              console.error('[AgentSession] backchannel failed', e);
            }
          }, 700);
        }
      }

      if (!ev.isFinal) return;
      clearCallerInterimPauseTimer();
      const text = ev.transcript?.trim();
      if (!text) return;
      const key = normalizeTranscriptKey(text);
      if (recentCallerTranscriptKeys.has(key)) return;
      recentCallerTranscriptKeys.add(key);
      bumpReplyTurn('caller_final_transcript');
      settleGreetingPhase('caller_spoke');
      appendTranscriptLine(ev.createdAt, `Caller: ${text}`);
      noteCallerGarble(session.userData.sessionFlags, session.userData.organizationId, text);
      resetClosePhaseIfCallerContinues(text);
      noteCallerTurnNeedsReply(text);
      if (session.userData.sessionFlags.awaitingAnythingElseReply) {
        session.userData.sessionFlags.callerRespondedAfterAnythingElse = true;
      }
      if (allowBookingAutomation && soundsLikeBookingIntent(text)) {
        const bookingRoute = activeRoutes(session.userData.routingLinks).find(isBookingRoute);
        if (bookingRoute) {
          session.userData.sessionFlags.bookingRouteId = bookingRoute.id;
        }
      }
      if (soundsLikeCancelOrChangeAppointment(text)) {
        session.userData.sessionFlags.bookingRouteId = null;
        session.userData.sessionFlags.bookingLinkConsentPending = false;
        session.userData.sessionFlags.bookingLinkConsentOfferSpoken = false;
        session.userData.sessionFlags.bookingSmsAutoSendStarted = false;
      }
      handleBookingConsentCallerTurn(text);
      maybeCloseAfterAnythingElse(text);
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      resetDeadAirTimer();
      const { item } = ev;
      if (item.type !== 'message') return;
      const { role } = item;
      if (role === 'developer' || role === 'system') return;
      const text = item.textContent?.trim();
      if (!text) return;

      if (role === 'user') {
        const key = normalizeTranscriptKey(text);
        if (recentCallerTranscriptKeys.has(key)) return;
        recentCallerTranscriptKeys.add(key);
        bumpReplyTurn('caller_conversation_item');
        settleGreetingPhase('caller_spoke');
        noteCallerGarble(session.userData.sessionFlags, session.userData.organizationId, text);
        resetClosePhaseIfCallerContinues(text);
        noteCallerTurnNeedsReply(text);
        if (session.userData.sessionFlags.awaitingAnythingElseReply) {
          session.userData.sessionFlags.callerRespondedAfterAnythingElse = true;
        }
        if (allowBookingAutomation && soundsLikeBookingIntent(text)) {
          const bookingRoute = activeRoutes(session.userData.routingLinks).find(isBookingRoute);
          if (bookingRoute) {
            session.userData.sessionFlags.bookingRouteId = bookingRoute.id;
          }
        }
        if (soundsLikeCancelOrChangeAppointment(text)) {
          session.userData.sessionFlags.bookingRouteId = null;
          session.userData.sessionFlags.bookingLinkConsentPending = false;
          session.userData.sessionFlags.bookingLinkConsentOfferSpoken = false;
          session.userData.sessionFlags.bookingSmsAutoSendStarted = false;
        }
        handleBookingConsentCallerTurn(text);
        maybeCloseAfterAnythingElse(text);
      }

      if (isCallEnding()) {
        const label = role === 'user' ? 'Caller' : 'Assistant';
        const interruptedNote =
          item.interrupted && (role === 'assistant' || role === 'user') ? ' [cut off]' : '';
        appendTranscriptLine(ev.createdAt, `${label}: ${text}${interruptedNote}`);
        return;
      }

      const flags = session.userData.sessionFlags;
      if (role === 'assistant' && text.length > 3 && !assistantTextSoundsLikeFakeHangup(text)) {
        callerAwaitingReply = false;
        lastAssistantChatText = text;
      }
      if (role === 'assistant' && assistantOfferedBookingLinkConsent(text)) {
        if (
          flags.bookingLinkConsentOfferSpoken &&
          !flags.linkSent &&
          !flags.bookingLinkConsentGranted
        ) {
          void safeGenerateReply(
            'You already asked for SMS consent — wait for yes or no. Do not repeat the link offer or booking pitch.',
          );
        } else {
          markBookingConsentOffered();
        }
      }
      if (role === 'assistant' && assistantClaimsLinkWasSent(text) && !flags.linkSent) {
        flags.assistantClaimedLinkSentSpoken = true;
        void safeGenerateReply(
          'SMS was NOT sent. Do not claim the link was texted or that the link has everything. Either wait for explicit yes and let the system send, or offer a team callback. Do not invoke endPhoneCall.',
        );
      }
      if (
        role === 'assistant' &&
        flags.bookingSmsAutoSendStarted &&
        /\b(that'?s sent|sent now|texted you|i'?ve texted)\b/i.test(text)
      ) {
        flags.bookingSendConfirmedSpoken = true;
      }
      if (role === 'assistant' && assistantAskedAnythingElse(text)) {
        if (flags.anythingElseAskCount >= 1 && !flags.callerRespondedAfterAnythingElse) {
          void safeGenerateReply(
            'Do not ask "anything else" again — the caller is still asking questions. Answer their question only.',
          );
        }
        flags.askedAnythingElse = true;
        flags.awaitingAnythingElseReply = true;
        flags.anythingElseAskCount += 1;
        flags.callerRespondedAfterAnythingElse = false;
        clearAllGuardTimers();
      }
      if (role === 'assistant' && assistantTextSoundsLikeGoodbye(text)) {
        flags.closingCall = true;
        clearAllGuardTimers();
      }
      if (
        role === 'assistant' &&
        hasCallerIdOnFile &&
        assistantAskedForPhoneNumber(text) &&
        !flags.endPhoneCallUsed
      ) {
        console.warn('[agent] blocked phone-number ask — caller ID on file', {
          display: callerLine.display,
        });
        void safeGenerateReply(
          `You must NOT ask for their phone number — caller ID is already on file (${callerLine.display}). Apologise in one short sentence, then continue helping. For messages or cancellations use takeCallbackMessage with name and staffSummary only — omit callbackPhone.`,
        );
      }

      if (
        role === 'assistant' &&
        !flags.endPhoneCallUsed &&
        (flags.linkSent || flags.actionTicketCreated) &&
        assistantTextSoundsLikeGoodbye(text)
      ) {
        clearGoodbyeForceTimer();
        goodbyeForceTimer = setTimeout(() => {
          goodbyeForceTimer = null;
          if (session.userData.sessionFlags.endPhoneCallUsed) return;
          void (async () => {
            await waitForSessionPlayout(session);
            if (session.userData.sessionFlags.endPhoneCallUsed) return;
            await disconnectCallerLeg(session, session.userData, async () => {});
          })();
        }, 3000);
      }

      if (role === 'assistant' && assistantTextSoundsLikeFakeHangup(text)) {
        clearFakeHangupGuardTimer();
        fakeHangupGuardTimer = setTimeout(() => {
          fakeHangupGuardTimer = null;
          if (session.userData.sessionFlags.endPhoneCallUsed) return;
          void disconnectCallerLeg(session, session.userData, () =>
            waitForSessionPlayout(session),
          );
        }, 500);
      }

      const label = role === 'user' ? 'Caller' : 'Assistant';
      const interruptedNote =
        item.interrupted && (role === 'assistant' || role === 'user') ? ' [cut off]' : '';
      appendTranscriptLine(ev.createdAt, `${label}: ${text}${interruptedNote}`);
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      resetDeadAirTimer();
      for (const [call, out] of voice.zipFunctionCallsAndOutputs(ev)) {
        if (call.name === 'endPhoneCall') {
          session.userData.sessionFlags.closingCall = true;
          clearAllGuardTimers();
        } else if (SLOW_TOOL_ACK_NAMES.has(call.name)) {
          scheduleResponseFillerForSlowWork();
        }
        if (out) {
          clearResponseFillerTimer();
        }
        appendTranscriptLine(
          call.createdAt ?? ev.createdAt,
          `[Tool] ${call.name} ${truncateForTranscript(call.args, MAX_TOOL_SNIPPET_CHARS)}`,
        );
        if (out) {
          const prefix = out.isError ? '[Tool error] ' : '[Tool result] ';
          appendTranscriptLine(
            out.createdAt,
            `${prefix}${truncateForTranscript(out.output, MAX_TOOL_SNIPPET_CHARS)}`,
          );
        }
      }
    });

    let callLogWritten = false;
    session.on(voice.AgentSessionEventTypes.Close, async () => {
      if (callLogWritten) return;
      clearAllGuardTimers();
      try {
        const ud = session.userData;
        if (!ud?.organizationId) return;

        const transcriptFlushMs = Number.parseInt(
          process.env.LIVEKIT_TRANSCRIPT_FLUSH_MS ?? '300',
          10,
        );
        await waitForSessionPlayout(session);
        if (Number.isFinite(transcriptFlushMs) && transcriptFlushMs > 0) {
          await new Promise((r) => setTimeout(r, Math.min(transcriptFlushMs, 2000)));
        }

        const durationSeconds = Math.max(0, Math.round((Date.now() - callStartedAt) / 1000));
        const outcome = canonicalCallOutcome({
          linkSent: ud.sessionFlags.linkSent,
          actionTicketCreated: ud.sessionFlags.actionTicketCreated,
          callbackRequested: ud.sessionFlags.callbackRequested,
          endPhoneCallUsed: ud.sessionFlags.endPhoneCallUsed,
        });

        const verbatimRaw = mergeTranscriptLines(transcriptParts);
        const verbatim = verbatimRaw ? redactPii(verbatimRaw) : null;
        const disclosureConfirmed = ud.disclosureConfirmed;
        const persistCalledNumber = calledNumber.trim() || org.phone_number?.trim() || '';

        let callLogId: string | null = null;
        const initialPayload = {
          called_number: persistCalledNumber,
          call_sid: callSidAttr,
          room_name: roomName || null,
          caller_number: callerNumberRaw,
          duration_seconds: durationSeconds,
          outcome,
          transcript: verbatim,
          transcript_review: null as string | null,
          ai_summary: null as string | null,
          disclosure_confirmed: disclosureConfirmed,
        };

        if (voiceWebhooksConfigured() && persistCalledNumber) {
          let webhookResult = await postCallComplete(initialPayload);
          if ((!webhookResult.ok || !webhookResult.callLogId) && durationSeconds >= 60) {
            console.warn('[agent] call-complete retry', {
              durationSeconds,
              error: webhookResult.error,
            });
            await new Promise((r) => setTimeout(r, 2000));
            webhookResult = await postCallComplete(initialPayload);
          }
          if (webhookResult.ok && webhookResult.callLogId) {
            callLogId = webhookResult.callLogId;
          } else {
            if (!webhookResult.ok) {
              console.error('[agent] call-complete webhook failed', {
                error: webhookResult.error,
                durationSeconds,
              });
            } else {
              console.error('[agent] call-complete webhook ok but missing call_log_id', {
                durationSeconds,
              });
            }
            callLogId = await insertCallLog({
              organizationId: ud.organizationId,
              callerNumber: callerNumberRaw,
              durationSeconds,
              outcome,
              transcript: verbatim,
            });
          }
        } else {
          callLogId = await insertCallLog({
            organizationId: ud.organizationId,
            callerNumber: callerNumberRaw,
            durationSeconds,
            outcome,
            transcript: verbatim,
          });
        }

        callLogWritten = true;
        console.info('[agent] call_log_persisted', {
          callLogId,
          outcome,
          transcriptLines: transcriptParts.length,
        });

        let transcriptReview: string | null = null;
        let aiSummary: string | null = null;
        let didPostprocess = false;
        if (verbatim) {
          const pp = await postprocessCallTranscript({
            verbatim,
            businessName: org.name,
            outcome,
            inferenceLlmModel,
          });
          transcriptReview = pp.transcriptReview ? redactPii(pp.transcriptReview) : null;
          aiSummary = pp.aiSummary ? redactPii(pp.aiSummary) : null;
          didPostprocess = true;
        }

        const costEstimate = estimateCallCostUsd({
          durationSeconds,
          smsSegmentsSent: ud.sessionFlags.smsSent,
          didPostprocess,
          transcriptChars: verbatim?.length ?? 0,
          sttModel: inferenceSttModel,
          llmModel: inferenceLlmModel,
          ttsModel: String(elevenModel),
        });

        if (callLogId && (transcriptReview || aiSummary || costEstimate)) {
          const enriched = await updateCallLogEnrichment(callLogId, {
            transcriptReview,
            aiSummary,
            costEstimate,
          });
          if (!enriched) {
            console.error('[agent] call log enrichment update failed', callLogId);
          }
        }

        const usageRecordId = await usageRecordIdPromise;
        if (usageRecordId) {
          await finishUsageRecord({ usageId: usageRecordId, durationSeconds });
        }
      } catch (err) {
        console.error('[AgentSession] close handler failed', err);
      }
    });

    class CaraVoiceAgent extends voice.Agent<CaraAgentUserData> {
      override async ttsNode(
        text: ReadableStream<string>,
        modelSettings: Parameters<voice.Agent<CaraAgentUserData>['ttsNode']>[1],
      ) {
        return voice.Agent.default.ttsNode(
          this,
          bufferTtsStreamBySentence(
            prepareTextForTtsStreaming(text, { ttsModel: elevenModel }),
          ),
          modelSettings,
        );
      }
    }

    const agent = new CaraVoiceAgent({
      instructions: systemPrompt,
      tools: caraTools.toolContext(),
    });

    await session.start({ agent, room: ctx.room });
    resetDeadAirTimer();

    const elevenVoiceSettings = resolveElevenVoiceSettings();

    const warmGreetingAudioCache = () => {
      if (!greetingText) return;
      const cacheKey = greetingAudioCacheKey(org.id, greetingText, elevenVoiceId);
      void (async () => {
        try {
          const existing = await loadCachedGreetingPcm(cacheKey);
          if (existing?.byteLength) return;
          const config = buildGreetingV3RenderConfig({
            apiKey: elevenApiKey,
            voiceId: elevenVoiceId,
            encoding: elevenEncoding,
            baseURL: elevenBaseUrl,
            voiceSettings: elevenVoiceSettings,
          });
          const pcm = await renderGreetingPcmForCache(config, greetingText);
          await storeCachedGreetingPcm(cacheKey, pcm);
          console.info('[agent] greeting v3 cache stored', { orgId: org.id, cacheKey });
        } catch (e) {
          console.error('[agent] greeting v3 cache warm failed', e);
        }
      })();
    };

    if (greetingText) {
      const cacheKey = greetingAudioCacheKey(org.id, greetingText, elevenVoiceId);
      const cachedPcm = await loadCachedGreetingPcm(cacheKey);
      let playedCached = false;
      if (cachedPcm?.byteLength) {
        try {
          const sampleRate = Number.parseInt(elevenEncoding.match(/(\d+)$/)?.[1] ?? '24000', 10);
          session.say(' ', {
            audio: pcmToAudioFrameStream(cachedPcm, sampleRate),
            addToChatCtx: false,
            allowInterruptions: true,
          });
          greetingAudioSpeechPending += 1;
          playedCached = true;
          greetingPlaybackStarted = true;
        } catch (e) {
          console.error('[agent] cached greeting play failed — live TTS fallback', e);
        }
      }
      if (!playedCached) {
        sayPrepared(session, greetingText, { greeting: true });
        greetingPlaybackStarted = true;
      }
      if (greetingIncludesAiDisclosure(greetingText)) {
        session.userData.disclosureConfirmed = true;
      }
      warmGreetingAudioCache();
    } else {
      allowBookingAutomation = true;
      await session.generateReply({
        instructions: `The caller just connected. Speak first with ONE short greeting for ${org.name}. Max 35 words. Include the AI and call-recording notice exactly as specified in your instructions.`,
      });
      session.userData.disclosureConfirmed = true;
    }
  },
});

const _agentNameRaw = process.env.LIVEKIT_AGENT_NAME;
const resolvedAgentName =
  _agentNameRaw === undefined ? 'cliste-salon-node' : _agentNameRaw.trim();

void reapZombieUsageRows();

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    ...(resolvedAgentName ? { agentName: resolvedAgentName } : {}),
  }),
);
