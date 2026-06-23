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
import { CaraTools, type CaraAgentUserData } from './lib/cara_tools.js';
import { estimateCallCostUsd } from './lib/call_cost_estimate.js';
import { postprocessCallTranscript } from './lib/call_postprocess.js';
import { insertCallLog, updateCallLogEnrichment } from './lib/call_logs.js';
import {
  assistantTextSoundsLikeFakeHangup,
  assistantTextSoundsLikeGoodbye,
  disconnectCallerLeg,
  waitForSessionPlayout,
  waitForSpeechHandlePlayout,
} from './lib/end_call.js';
import { createElevenLabsTts } from './lib/elevenlabs-v3-http-tts.js';
import { greetingIncludesAiDisclosure } from './lib/greeting_compliance.js';
import {
  ensureGreetingPcmCached,
  greetingAudioCacheKey,
  loadCachedGreetingPcm,
  pcmSampleRateFromEncoding,
  pcmToAudioFrameStream,
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
import { sayPrepared } from './lib/say_prepared.js';
import {
  assistantAskedAnythingElse,
  assistantAwaitingCallerReply,
  callerAskedNewQuestion,
  callerSaidNothingElse,
  callerWindingDownCall,
} from './lib/speech_triggers.js';
import {
  detectLikelySttGarble,
  isPhantomCallerTranscript,
  soundsLikeCancelOrChangeAppointment,
} from './lib/stt_garble.js';
import {
  getOrgForCall,
  getSendableBusinessFiles,
  resolveOrgTimeZone,
  resolveOrgVoiceId,
} from './lib/supabase.js';
import {
  bufferTtsStreamBySentence,
  prepareHardcodedSpeechForTts,
  prepareTextForTtsStreaming,
  setActiveTtsModelForSanitizer,
} from './lib/tts_text_sanitize.js';
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
import { mirrorLatestCall } from './lib/sync_latest_call_transcript.js';
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
const LLM_STALL_MS = 6000;
const CALLER_TRANSCRIPT_DEDUPE_MS = 3000;
const GREETING_INTERRUPT_FALLBACK_MS = 1500;
const GREETING_PLAYBACK_FALLBACK_MS = 800;

/** Optional slow-tool stall phrases — disabled by default (see LIVEKIT_RESPONSE_FILLER_MS). */
const RESPONSE_FILLER_PHRASES = ['Let me see now…'] as const;

const REPLY_RETRY_INSTRUCTIONS =
  'Your last reply did not reach the caller. One short warm line — acknowledge what they asked — then continue. No service menu. If waiting on SMS yes/no, do not re-offer the link.';

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
  'sendBookingLink',
  'sendDirectionsLink',
  'sendRoutingLink',
  'sendRoutingFile',
  'searchBusinessFile',
  'takeCallbackMessage',
  'transferToTeam',
]);

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
    const livekitJobId =
      typeof (ctx.job as { id?: string }).id === 'string'
        ? (ctx.job as { id: string }).id
        : null;
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
        bookingRouteId: null,
        bookingLinkSendInFlight: false,
        closingCall: false,
        likelySttGarble: false,
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
    const llmProvider = process.env.CARA_LLM_PROVIDER?.trim().toLowerCase();
    const openAiKey = process.env.OPENAI_API_KEY?.trim();
    const useDirectOpenAiLlm = llmProvider !== 'gateway' && !!openAiKey;

    const elevenVoiceId =
      resolveOrgVoiceId(org) || process.env.ELEVEN_VOICE_ID?.trim() || 'C92s6vssSLlabgIln1iY';
    const elevenModel = elevenModelEarly;
    const elevenEncoding = process.env.ELEVEN_TTS_ENCODING?.trim() || 'pcm_24000';
    const elevenBaseUrl =
      process.env.ELEVENLABS_BASE_URL?.trim() || 'https://api.elevenlabs.io/v1';
    const elevenVoiceSettings = resolveElevenVoiceSettings();

    const greetingCacheKey = greetingText
      ? greetingAudioCacheKey(org.id, greetingText, elevenVoiceId)
      : null;

    const greetingCacheWarmPromise = greetingText
      ? ensureGreetingPcmCached({
          orgId: org.id,
          greetingText,
          apiKey: elevenApiKey,
          voiceId: elevenVoiceId,
          encoding: elevenEncoding,
          baseURL: elevenBaseUrl,
          voiceSettings: elevenVoiceSettings,
        })
          .then((pcm) => {
            console.info('[agent] greeting_pcm_warm', {
              orgId: org.id,
              bytes: pcm.byteLength,
              msSinceCallStart: Date.now() - callStartedAt,
            });
          })
          .catch((e) => {
            console.error('[agent] greeting pcm warmup failed', e);
          })
      : null;

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
        preemptiveGeneration: { enabled: false },
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

    const deadAirMs = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_MS ?? '10000', 10);
    const deadAirCloseMs = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_CLOSE_MS ?? '8000', 10);
    const deadAirMaxPrompts = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_MAX_PROMPTS ?? '2', 10);
    const responseFillerMs = Number.parseInt(process.env.LIVEKIT_RESPONSE_FILLER_MS ?? '0', 10);
    const responseFillerMaxPerCall = Number.parseInt(
      process.env.LIVEKIT_RESPONSE_FILLER_MAX_PER_CALL ?? '3',
      10,
    );
    const postGreetingGraceMs = Number.parseInt(
      process.env.LIVEKIT_POST_GREETING_GRACE_MS ?? '5000',
      10,
    );
    const postGreetingInterruptGraceMs = Number.parseInt(
      process.env.LIVEKIT_POST_GREETING_INTERRUPT_GRACE_MS ?? '500',
      10,
    );
    let fakeHangupGuardTimer: ReturnType<typeof setTimeout> | null = null;
    let goodbyeForceTimer: ReturnType<typeof setTimeout> | null = null;
    let deadAirTimer: ReturnType<typeof setTimeout> | null = null;
    let deadAirCloseTimer: ReturnType<typeof setTimeout> | null = null;
    let deadAirPromptCount = 0;
    let responseFillerTimer: ReturnType<typeof setTimeout> | null = null;
    let responseFillerCount = 0;
    let greetingInterruptFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let callerAwaitingReply = false;
    let replyTurnEpoch = 0;
    let replyRetryUsedForTurn = false;
    let generateReplyInFlight = false;
    let generateReplyStartedAt = 0;
    let allowBookingAutomation = false;
    let greetingPlaybackStarted = false;
    let greetingAudioSpeechPending = 0;
    let listenGraceUntil = 0;
    let callerHasFinalTranscript = false;
    let lastAssistantChatText = '';
    let lastAssistantSpokeAt = 0;
    let programmaticSpeechPending = 0;
    let lastCallerUtterance = '';
    let llmReplySpeechQueued = false;

    let thinkingStartedAt: number | null = null;
    let userStoppedSpeakingAt: number | null = null;

    const transcriptParts: TranscriptLine[] = [];
    let transcriptSeq = 0;
    const recentCallerTranscripts = new Map<string, number>();

    const normalizeTranscriptKey = (text: string) =>
      text.trim().toLowerCase().replace(/\s+/g, ' ');

    const isDuplicateCallerUtterance = (key: string, at: number): boolean => {
      const prev = recentCallerTranscripts.get(key);
      if (prev !== undefined && at - prev < CALLER_TRANSCRIPT_DEDUPE_MS) {
        return true;
      }
      recentCallerTranscripts.set(key, at);
      return false;
    };

    const appendTranscriptLine = (at: number, line: string) => {
      transcriptParts.push({ at, seq: transcriptSeq++, line });
    };

    const hasCallerTranscript = () =>
      transcriptParts.some((p) => p.line.startsWith('Caller:'));

    const inListenGrace = () =>
      listenGraceUntil > 0 && Date.now() < listenGraceUntil;

    const bumpReplyTurn = (reason: string) => {
      replyTurnEpoch += 1;
      generateReplyInFlight = false;
      generateReplyStartedAt = 0;
      replyRetryUsedForTurn = false;
      listenGraceUntil = 0;
      callerHasFinalTranscript = true;
      llmReplySpeechQueued = false;
      console.info('[agent] reply_turn_bump', { epoch: replyTurnEpoch, reason });
    };

    const isCallEnding = () => {
      const f = session.userData.sessionFlags;
      return f.endPhoneCallUsed || f.closingCall;
    };

    const safeGenerateReply = (instructions: string, opts?: { force?: boolean }) => {
      const epoch = replyTurnEpoch;
      if (generateReplyInFlight && !opts?.force) {
        const stalledFor = Date.now() - generateReplyStartedAt;
        if (stalledFor > LLM_STALL_MS) {
          console.warn('[agent] generateReply_stale_reset', { stalledFor, epoch });
          generateReplyInFlight = false;
          generateReplyStartedAt = 0;
          replyTurnEpoch += 1;
        } else {
          console.warn('[agent] generateReply_suppressed — single-flight', { epoch });
          return;
        }
      }
      generateReplyInFlight = true;
      generateReplyStartedAt = Date.now();
      const activeEpoch = replyTurnEpoch;
      const handle = session.generateReply({ instructions });
      void Promise.resolve(handle)
        .catch((e) => {
          console.error('[AgentSession] generateReply failed', e);
          retryFailedReplyOnce('generateReply_failed');
        })
        .finally(() => {
          if (activeEpoch === replyTurnEpoch) {
            generateReplyInFlight = false;
            generateReplyStartedAt = 0;
          }
        });
    };

    const canPlayRecoverySpeech = (): boolean => {
      if (isCallEnding()) return false;
      if (session.userState === 'speaking') return false;
      if (inListenGrace()) return false;
      return true;
    };

    const retryFailedReplyOnce = (source: string) => {
      if (replyRetryUsedForTurn || isCallEnding()) return;
      if (!canPlayRecoverySpeech()) return;
      replyRetryUsedForTurn = true;
      console.warn('[agent] reply_retry', { source, epoch: replyTurnEpoch });
      safeGenerateReply(REPLY_RETRY_INSTRUCTIONS, { force: true });
    };

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const err = ev.error;
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : String(err);
      console.error('[AgentSession] pipeline error', msg);
      retryFailedReplyOnce('pipeline_error');
    });

    const clearGreetingInterruptFallbackTimer = () => {
      if (greetingInterruptFallbackTimer) {
        clearTimeout(greetingInterruptFallbackTimer);
        greetingInterruptFallbackTimer = null;
      }
    };

    const scheduleGreetingInterruptFallback = () => {
      clearGreetingInterruptFallbackTimer();
      if (GREETING_INTERRUPT_FALLBACK_MS <= 0 || isCallEnding()) return;
      greetingInterruptFallbackTimer = setTimeout(() => {
        greetingInterruptFallbackTimer = null;
        if (isCallEnding()) return;
        if (session.agentState === 'thinking' || session.agentState === 'speaking') return;
        if (generateReplyInFlight) return;
        console.warn('[agent] greeting_interrupt_fallback_reply');
        safeGenerateReply(
          'The caller spoke while you were greeting. Respond warmly in one short line and ask how you can help.',
        );
      }, GREETING_INTERRUPT_FALLBACK_MS);
    };

    const settleGreetingPhase = (reason: string) => {
      if (allowBookingAutomation) return;
      allowBookingAutomation = true;
      const graceMs =
        reason === 'greeting_interrupted'
          ? postGreetingInterruptGraceMs
          : postGreetingGraceMs;
      if (graceMs > 0) {
        listenGraceUntil = Date.now() + graceMs;
      }
      console.info('[agent] greeting_phase_settled', {
        reason,
        listenGraceMs: graceMs,
      });
      if (reason === 'greeting_interrupted') {
        scheduleGreetingInterruptFallback();
      } else if (reason === 'greeting_completed' && greetingText.trim()) {
        appendTranscriptLine(Date.now(), `Assistant: ${greetingText.trim()}`);
      }
    };

    const sayProgrammatic = (text: string, opts?: Parameters<typeof sayPrepared>[2]) => {
      programmaticSpeechPending += 1;
      sayPrepared(session, text, { addToChatCtx: false, ...opts });
    };

    const ingestCallerFinalText = (
      text: string,
      bumpReason: string,
      at: number,
    ): boolean => {
      lastCallerUtterance = text.trim();
      if (isPhantomCallerTranscript(text)) {
        console.warn('[agent] phantom_caller_transcript_ignored', {
          snippet: text.slice(0, 60),
          reason: bumpReason,
        });
        return false;
      }
      const key = normalizeTranscriptKey(text);
      if (isDuplicateCallerUtterance(key, at)) return false;
      bumpReplyTurn(bumpReason);
      settleGreetingPhase('caller_spoke');
      appendTranscriptLine(at, `Caller: ${text}`);
      noteCallerGarble(session.userData.sessionFlags, session.userData.organizationId, text);
      resetClosePhaseIfCallerContinues(text);
      noteCallerTurnNeedsReply(text);
      if (session.userData.sessionFlags.awaitingAnythingElseReply) {
        session.userData.sessionFlags.callerRespondedAfterAnythingElse = true;
      }
      if (soundsLikeCancelOrChangeAppointment(text)) {
        session.userData.sessionFlags.bookingRouteId = null;
      }
      maybeCloseAfterAnythingElse(text);
      return true;
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

    const shouldSuppressFillers = () => {
      const f = session.userData.sessionFlags;
      return (
        !allowBookingAutomation ||
        isCallEnding() ||
        f.askedAnythingElse ||
        f.awaitingAnythingElseReply ||
        f.closingCall ||
        f.bookingLinkSendInFlight
      );
    };

    const noteCallerTurnNeedsReply = (text: string) => {
      if (text.length > 12) {
        callerAwaitingReply = true;
      }
    };

    const maybeCloseAfterAnythingElse = (text: string) => {
      const flags = session.userData.sessionFlags;
      if (!flags.askedAnythingElse || !callerWindingDownCall(text)) return;
      if (flags.bookingLinkSendInFlight) return;
      if (flags.endPhoneCallUsed || flags.closingCall) return;

      flags.callerRespondedAfterAnythingElse = true;
      flags.closingCall = true;
      clearAllGuardTimers();
      try {
        session.interrupt();
      } catch {
        /* ignore */
      }
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

    const gracefulDisconnect = () => {
      void disconnectCallerLeg(session, session.userData, () => waitForSessionPlayout(session));
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
        sayProgrammatic(phrase, { addToChatCtx: false, allowInterruptions: true });
      }, responseFillerMs);
    };

    const clearAllGuardTimers = () => {
      clearFakeHangupGuardTimer();
      clearGoodbyeForceTimer();
      clearDeadAirTimers();
      clearResponseFillerTimer();
      clearGreetingInterruptFallbackTimer();
    };

    const resetDeadAirTimer = () => {
      clearDeadAirTimers();
      if (isCallEnding()) return;
      const f = session.userData.sessionFlags;
      if (f.askedAnythingElse && f.callerRespondedAfterAnythingElse) return;
      if (f.bookingLinkSendInFlight) return;
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
          sayProgrammatic('Sorry — are you still there?');
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

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      resetDeadAirTimer();
      if (ev.oldState === 'speaking' && ev.newState === 'listening') {
        userStoppedSpeakingAt = Date.now();
      }
      if (ev.newState === 'speaking') {
        userStoppedSpeakingAt = null;
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState === 'speaking' || ev.newState === 'listening') {
        clearResponseFillerTimer();
      }
      if (ev.newState === 'thinking' || ev.newState === 'speaking') {
        clearGreetingInterruptFallbackTimer();
      }
      if (ev.newState === 'speaking') {
        lastAssistantSpokeAt = Date.now();
        if (thinkingStartedAt !== null) {
          console.info('[agent] thinking_to_speaking_ms', Date.now() - thinkingStartedAt);
          thinkingStartedAt = null;
        }
      } else if (ev.newState === 'thinking' && !isCallEnding()) {
        if (userStoppedSpeakingAt !== null) {
          console.info(
            '[agent] user_speaking_to_thinking_ms',
            Date.now() - userStoppedSpeakingAt,
          );
          userStoppedSpeakingAt = null;
        }
        thinkingStartedAt = Date.now();
      }
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      resetDeadAirTimer();
      if (session.agentState === 'thinking' || generateReplyInFlight) {
        llmReplySpeechQueued = true;
      }
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
          if (programmaticSpeechPending > 0) {
            programmaticSpeechPending -= 1;
            return;
          }
          // SpeechHandle text/source can be empty even when TTS played; chat ctx has the line.
          if (lastAssistantChatText.trim()) {
            lastAssistantChatText = '';
            return;
          }
          if (lastAssistantSpokeAt > 0 && Date.now() - lastAssistantSpokeAt < 8000) {
            return;
          }
          console.warn('[agent] empty_speech_handle', {
            userState: session.userState,
            agentState: session.agentState,
            hasCallerTranscript: hasCallerTranscript(),
            inListenGrace: inListenGrace(),
            lastAssistantSnippet: lastAssistantChatText.slice(0, 80),
          });
          retryFailedReplyOnce('empty_speech_handle');
          return;
        }
        if (lastAssistantChatText.trim()) {
          lastAssistantChatText = '';
        }
      });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      const text = ev.transcript?.trim();
      if (!text) return;
      ingestCallerFinalText(text, 'caller_final_transcript', ev.createdAt);
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
        ingestCallerFinalText(text, 'caller_conversation_item', ev.createdAt);
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
        if (assistantAwaitingCallerReply(text)) {
          callerAwaitingReply = true;
        } else {
          callerAwaitingReply = false;
        }
        lastAssistantChatText = text;
      }
      if (role === 'assistant' && assistantAskedAnythingElse(text)) {
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

      if (role === 'assistant') {
        const label = 'Assistant';
        const interruptedNote = item.interrupted ? ' [cut off]' : '';
        appendTranscriptLine(ev.createdAt, `${label}: ${text}${interruptedNote}`);
      }
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

      const mirrorBase = () => ({
        callerNumber: callerNumberRaw,
        startedAtMs: callStartedAt,
        jobId: livekitJobId,
        orgName: org.name,
      });

      let durationSeconds = 0;
      let outcome = 'answered';
      let verbatim: string | null = null;
      let callLogId: string | null = null;
      let aiSummary: string | null = null;

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

        durationSeconds = Math.max(0, Math.round((Date.now() - callStartedAt) / 1000));
        outcome = canonicalCallOutcome({
          linkSent: ud.sessionFlags.linkSent,
          actionTicketCreated: ud.sessionFlags.actionTicketCreated,
          callbackRequested: ud.sessionFlags.callbackRequested,
          endPhoneCallUsed: ud.sessionFlags.endPhoneCallUsed,
        });

        const verbatimRaw = mergeTranscriptLines(transcriptParts);
        verbatim = verbatimRaw ? redactPii(verbatimRaw) : null;

        mirrorLatestCall({
          ...mirrorBase(),
          callLogId: null,
          durationSeconds,
          outcome,
          transcript: verbatim,
          aiSummary: null,
        });

        const disclosureConfirmed = ud.disclosureConfirmed;
        const persistCalledNumber = calledNumber.trim() || org.phone_number?.trim() || '';

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
        let didPostprocess = false;
        let knowledgeGaps: Array<{
          topic: string;
          caller_context?: string;
          cara_question?: string;
          suggested_section?: string;
        }> = [];
        if (verbatim) {
          const pp = await postprocessCallTranscript({
            verbatim,
            businessName: org.name,
            outcome,
            inferenceLlmModel,
            actionTicketCreated: ud.sessionFlags.actionTicketCreated,
          });
          transcriptReview = pp.transcriptReview ? redactPii(pp.transcriptReview) : null;
          aiSummary = pp.aiSummary ? redactPii(pp.aiSummary) : null;
          knowledgeGaps = pp.knowledgeGaps;
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

        if (
          callLogId &&
          knowledgeGaps.length > 0 &&
          voiceWebhooksConfigured() &&
          persistCalledNumber
        ) {
          const gapPayload = {
            called_number: persistCalledNumber,
            call_sid: callSidAttr,
            room_name: roomName || null,
            caller_number: callerNumberRaw,
            duration_seconds: durationSeconds,
            outcome,
            knowledge_gaps: knowledgeGaps,
          };
          const gapResult = await postCallComplete(gapPayload);
          if (!gapResult.ok) {
            console.warn('[agent] knowledge_gaps webhook failed', {
              error: gapResult.error,
              gapCount: knowledgeGaps.length,
            });
          }
        }

        const usageRecordId = await usageRecordIdPromise;
        if (usageRecordId) {
          await finishUsageRecord({ usageId: usageRecordId, durationSeconds });
        }

        mirrorLatestCall({
          ...mirrorBase(),
          callLogId,
          durationSeconds,
          outcome,
          transcript: verbatim,
          aiSummary,
        });
      } catch (err) {
        console.error('[AgentSession] close handler failed', err);
        if (verbatim) {
          mirrorLatestCall({
            ...mirrorBase(),
            callLogId,
            durationSeconds,
            outcome,
            transcript: verbatim,
            aiSummary,
          });
        }
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

    if (greetingText) {
      void greetingCacheWarmPromise;

      const playLiveTtsGreeting = () => {
        sayPrepared(session, greetingText, { greeting: true, allowInterruptions: false });
        greetingPlaybackStarted = true;
        console.info('[agent] greeting_playback', {
          source: 'live_tts',
          msSinceCallStart: Date.now() - callStartedAt,
        });
      };

      const cachedPcm = greetingCacheKey
        ? await loadCachedGreetingPcm(greetingCacheKey)
        : null;

      if (cachedPcm?.byteLength) {
        let fallbackUsed = false;
        try {
          const sampleRate = pcmSampleRateFromEncoding(elevenEncoding);
          const spokenText = prepareHardcodedSpeechForTts(greetingText, { greeting: true });
          const handle = session.say(spokenText, {
            audio: pcmToAudioFrameStream(cachedPcm, sampleRate),
            addToChatCtx: true,
            allowInterruptions: false,
          });
          greetingAudioSpeechPending += 1;
          greetingPlaybackStarted = true;
          console.info('[agent] greeting_playback', {
            source: 'cached_pcm',
            msSinceCallStart: Date.now() - callStartedAt,
          });

          const watchdog = setTimeout(() => {
            if (session.agentState !== 'speaking' && !fallbackUsed) {
              fallbackUsed = true;
              console.warn('[agent] greeting_playback_fallback', {
                reason: 'no_speaking_state',
                msSinceCallStart: Date.now() - callStartedAt,
              });
              try {
                session.interrupt();
              } catch {
                /* ignore */
              }
              playLiveTtsGreeting();
            }
          }, GREETING_PLAYBACK_FALLBACK_MS);

          try {
            await waitForSpeechHandlePlayout(handle);
          } catch (e) {
            console.error('[agent] cached greeting playout failed — live TTS fallback', e);
            if (!fallbackUsed && session.agentState !== 'speaking') {
              fallbackUsed = true;
              playLiveTtsGreeting();
            }
          } finally {
            clearTimeout(watchdog);
          }
        } catch (e) {
          console.error('[agent] cached greeting play failed — live TTS fallback', e);
          playLiveTtsGreeting();
        }
      } else {
        playLiveTtsGreeting();
      }

      if (greetingIncludesAiDisclosure(greetingText)) {
        session.userData.disclosureConfirmed = true;
      }
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
