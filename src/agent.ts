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
} from './lib/end_call.js';
import { createElevenLabsTts } from './lib/elevenlabs-v3-http-tts.js';
import { greetingIncludesAiDisclosure } from './lib/greeting_compliance.js';
import { maskPhone, redactPii } from './lib/gdpr.js';
import { assertOrgCallable } from './lib/org_gate.js';
import {
  callerE164ForBlocklist,
  checkCallerBlocklist,
  rejectBlockedCaller,
  stableCallSidFallback,
} from './lib/caller_blocklist.js';
import { classifyCallerLine, type CallerLineInfo } from './lib/phone_classify.js';
import {
  getOrgForCall,
  getSendableBusinessFiles,
  resolveOrgTimeZone,
  resolveOrgVoiceId,
} from './lib/supabase.js';
import { stripForbiddenTtsPhrasesStreaming } from './lib/tts_text_sanitize.js';
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

type TranscriptLine = { at: number; seq: number; line: string };

function truncateForTranscript(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 24))}… [truncated]`;
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
    const calledNumber = resolveCalledNumber(routing.phone, org.phone_number);
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
    const systemPrompt = buildCaraCallPrompt({
      businessName: org.name,
      customPrompt: custom,
      callerLine,
      routingLinks,
      bookingTimeZone: bookingTz,
      nowUtcIso,
      todayLocal,
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
      process.env.LIVEKIT_INFERENCE_STT_MODEL?.trim() || 'assemblyai/universal-streaming';
    const inferenceSttLanguage = process.env.LIVEKIT_INFERENCE_STT_LANGUAGE?.trim() || 'en';
    const inferenceLlmModel =
      process.env.LIVEKIT_INFERENCE_LLM_MODEL?.trim() || 'openai/gpt-4o-mini';
    const useDirectOpenAiLlm =
      process.env.CARA_LLM_PROVIDER?.trim().toLowerCase() === 'openai' &&
      !!process.env.OPENAI_API_KEY?.trim();

    const elevenVoiceId =
      resolveOrgVoiceId(org) || process.env.ELEVEN_VOICE_ID?.trim() || 'C92s6vssSLlabgIln1iY';
    const elevenModel =
      (process.env.ELEVEN_TTS_MODEL?.trim() || 'eleven_flash_v2_5') as elevenlabs.TTSModels;
    const elevenEncoding = process.env.ELEVEN_TTS_ENCODING?.trim() || 'pcm_24000';
    const elevenBaseUrl =
      process.env.ELEVENLABS_BASE_URL?.trim() || 'https://api.elevenlabs.io/v1';

    const endpointMinMs = Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MIN_MS ?? '80', 10);
    const endpointMaxMs = Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MAX_MS ?? '900', 10);
    const endpointMode = (process.env.LIVEKIT_ENDPOINTING_MODE?.trim() || 'dynamic') as
      | 'fixed'
      | 'dynamic';
    const useTurnDetector =
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

    const orgNameTokens = org.name ? org.name.split(/\s+/).filter((w) => w.length > 1) : [];
    const envExtra =
      process.env.LIVEKIT_STT_EXTRA_KEYTERMS?.split(/[,;]+/)
        .map((s) => s.trim())
        .filter((w) => w.length > 1) ?? [];
    const sttKeyterms = [...new Set([...envExtra, ...orgNameTokens])].slice(0, 100);

    const llmTemperature = Number.parseFloat(process.env.LIVEKIT_LLM_TEMPERATURE ?? '0.45');
    const llmMaxCompletionTokens = Number.parseInt(process.env.LIVEKIT_LLM_MAX_TOKENS ?? '220', 10);

    const sttModelLower = inferenceSttModel.toLowerCase();
    const sttModelOptions = sttModelLower.includes('assemblyai')
      ? { ...(sttKeyterms.length > 0 ? { keyterms_prompt: sttKeyterms } : {}) }
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
      llm: useDirectOpenAiLlm ? `openai-direct:${directOpenAiLlmModel}` : inferenceLlmModel,
      tts: `elevenlabs:${elevenModel}`,
    });

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
        voiceSettings: {
          stability: Number.parseFloat(process.env.ELEVEN_VOICE_STABILITY ?? '0.5') || 0.5,
          similarity_boost: Number.parseFloat(process.env.ELEVEN_VOICE_SIMILARITY ?? '0.75') || 0.75,
          style: Number.parseFloat(process.env.ELEVEN_VOICE_STYLE ?? '0.35') || 0.35,
          use_speaker_boost: true,
        },
      }),
      userData: sessionUserData,
      preemptiveGeneration: true,
      maxToolSteps: 5,
      turnHandling: {
        turnDetection: turnDetectorInstance ?? 'stt',
        endpointing: {
          mode: endpointMode,
          minDelay: Number.isFinite(endpointMinMs) ? endpointMinMs : 80,
          maxDelay: Number.isFinite(endpointMaxMs) ? endpointMaxMs : 900,
        },
        interruption: {
          mode: interruptionMode,
          discardAudioIfUninterruptible:
            process.env.LIVEKIT_DISCARD_AUDIO_IF_UNINTERRUPTIBLE?.trim().toLowerCase() !== 'false',
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
    const responseFillerMs = Number.parseInt(process.env.LIVEKIT_RESPONSE_FILLER_MS ?? '1500', 10);
    const responseFillerMaxPerCall = Number.parseInt(
      process.env.LIVEKIT_RESPONSE_FILLER_MAX_PER_CALL ?? '3',
      10,
    );
    const deadAirMs = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_MS ?? '7000', 10);
    const deadAirCloseMs = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_CLOSE_MS ?? '8000', 10);
    const deadAirMaxPrompts = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_MAX_PROMPTS ?? '2', 10);
    let silenceRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let silenceRecoveryCount = 0;
    let fakeHangupGuardTimer: ReturnType<typeof setTimeout> | null = null;
    let fillerNoToolGuardTimer: ReturnType<typeof setTimeout> | null = null;
    let goodbyeForceTimer: ReturnType<typeof setTimeout> | null = null;
    let responseFillerTimer: ReturnType<typeof setTimeout> | null = null;
    let responseFillerCount = 0;
    let deadAirTimer: ReturnType<typeof setTimeout> | null = null;
    let deadAirCloseTimer: ReturnType<typeof setTimeout> | null = null;
    let deadAirPromptCount = 0;

    const RESPONSE_FILLER_PHRASES = [
      'Bear with me one second.',
      'Just a moment.',
      'Let me see.',
    ] as const;

    const isCallEnding = () => session.userData.sessionFlags.endPhoneCallUsed;

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
    const clearFillerNoToolGuardTimer = () => {
      if (fillerNoToolGuardTimer) {
        clearTimeout(fillerNoToolGuardTimer);
        fillerNoToolGuardTimer = null;
      }
    };
    const clearGoodbyeForceTimer = () => {
      if (goodbyeForceTimer) {
        clearTimeout(goodbyeForceTimer);
        goodbyeForceTimer = null;
      }
    };
    const clearResponseFillerTimer = () => {
      if (responseFillerTimer) {
        clearTimeout(responseFillerTimer);
        responseFillerTimer = null;
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

    const clearAllGuardTimers = () => {
      clearSilenceRecoveryTimer();
      clearFakeHangupGuardTimer();
      clearFillerNoToolGuardTimer();
      clearGoodbyeForceTimer();
      clearResponseFillerTimer();
      clearDeadAirTimers();
    };

    const scheduleResponseFiller = () => {
      if (isCallEnding()) return;
      clearResponseFillerTimer();
      responseFillerTimer = setTimeout(() => {
        responseFillerTimer = null;
        try {
          if (isCallEnding()) return;
          if (session.agentState === 'speaking' || session.userState === 'speaking') return;
          if (responseFillerCount >= responseFillerMaxPerCall) return;
          responseFillerCount += 1;
          const phrase =
            RESPONSE_FILLER_PHRASES[Math.floor(Math.random() * RESPONSE_FILLER_PHRASES.length)]!;
          session.say(phrase);
        } catch (e) {
          console.error('[AgentSession] response filler failed', e);
        }
      }, responseFillerMs);
    };

    const resetDeadAirTimer = () => {
      clearDeadAirTimers();
      if (isCallEnding()) return;
      deadAirTimer = setTimeout(() => {
        deadAirTimer = null;
        try {
          if (isCallEnding()) return;
          if (session.agentState !== 'listening' || session.userState === 'speaking') return;
          if (deadAirPromptCount >= deadAirMaxPrompts) {
            gracefulDisconnect();
            return;
          }
          deadAirPromptCount += 1;
          session.say('Sorry — are you still there?');
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

    const assistantTextSoundsLikeFiller = (t: string): boolean => {
      const s = t.toLowerCase();
      return (
        /\bone moment\b/.test(s) ||
        /\blet me (have a look|check|see|pull)/.test(s) ||
        /\bgive me a (second|sec|moment)/.test(s) ||
        /\bbear with me\b/.test(s)
      );
    };

    const scheduleSilenceRecoveryAfterCutoff = () => {
      if (isCallEnding()) return;
      clearSilenceRecoveryTimer();
      silenceRecoveryTimer = setTimeout(() => {
        silenceRecoveryTimer = null;
        try {
          if (isCallEnding()) return;
          if (session.userState === 'speaking' || session.agentState !== 'listening') return;
          if (silenceRecoveryCount >= silenceRecoveryMaxPerCall) return;
          silenceRecoveryCount += 1;
          void session.generateReply({
            instructions:
              'Your previous reply may not have played. One short warm line — sorry about that — then continue helping with their last request. Do not go silent.',
          });
        } catch (e) {
          console.error('[AgentSession] silence recovery failed', e);
        }
      }, silenceRecoveryDelayMs);
    };

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      resetDeadAirTimer();
      if (ev.newState === 'speaking') {
        clearSilenceRecoveryTimer();
        clearFillerNoToolGuardTimer();
        clearResponseFillerTimer();
      } else if (ev.newState === 'listening') {
        if (!isCallEnding()) scheduleResponseFiller();
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState === 'speaking') {
        clearResponseFillerTimer();
      } else if (ev.newState === 'thinking' && !isCallEnding()) {
        scheduleResponseFiller();
      }
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      clearResponseFillerTimer();
      resetDeadAirTimer();
      ev.speechHandle.addDoneCallback((sh) => {
        if (sh.interrupted) scheduleSilenceRecoveryAfterCutoff();
      });
    });

    const transcriptParts: TranscriptLine[] = [];
    let transcriptSeq = 0;
    const recentCallerTranscriptKeys = new Set<string>();

    const normalizeTranscriptKey = (text: string) =>
      text.trim().toLowerCase().replace(/\s+/g, ' ');

    const appendTranscriptLine = (at: number, line: string) => {
      transcriptParts.push({ at, seq: transcriptSeq++, line });
    };

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      const text = ev.transcript?.trim();
      if (!text) return;
      const key = normalizeTranscriptKey(text);
      if (recentCallerTranscriptKeys.has(key)) return;
      recentCallerTranscriptKeys.add(key);
      appendTranscriptLine(ev.createdAt, `Caller: ${text}`);
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
      }

      if (isCallEnding()) {
        const label = role === 'user' ? 'Caller' : 'Assistant';
        const interruptedNote =
          item.interrupted && (role === 'assistant' || role === 'user') ? ' [cut off]' : '';
        appendTranscriptLine(ev.createdAt, `${label}: ${text}${interruptedNote}`);
        return;
      }

      const flags = session.userData.sessionFlags;
      if (role === 'assistant' && assistantTextSoundsLikeFiller(text)) {
        clearFillerNoToolGuardTimer();
        fillerNoToolGuardTimer = setTimeout(() => {
          fillerNoToolGuardTimer = null;
          try {
            if (isCallEnding()) return;
            if (session.userState === 'speaking' || session.agentState !== 'listening') return;
            void session.generateReply({
              instructions:
                'You said "one moment" but did not run a tool. Either invoke the right tool now or ask the single next question you need.',
            });
          } catch (e) {
            console.error('[AgentSession] filler-no-tool recovery failed', e);
          }
        }, Number.parseInt(process.env.LIVEKIT_FILLER_NO_TOOL_MS ?? '1800', 10));
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
          void disconnectCallerLeg(session, session.userData, () =>
            waitForSessionPlayout(session),
          );
        }, 1500);
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
      clearFillerNoToolGuardTimer();
      resetDeadAirTimer();
      for (const [call, out] of voice.zipFunctionCallsAndOutputs(ev)) {
        if (call.name === 'endPhoneCall') {
          clearAllGuardTimers();
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
          const webhookResult = await postCallComplete(initialPayload);
          if (webhookResult.ok) {
            callLogId = webhookResult.callLogId ?? null;
          } else {
            console.error('[agent] call-complete webhook failed', webhookResult.error);
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
          stripForbiddenTtsPhrasesStreaming(text),
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
      session.say(greetingText);
      if (greetingIncludesAiDisclosure(greetingText)) {
        session.userData.disclosureConfirmed = true;
      }
    } else {
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
