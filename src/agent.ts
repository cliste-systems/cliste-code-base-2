import 'dotenv/config';

import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as lkTurn from '@livekit/agents-plugin-livekit';
import { createCaraLlm } from './lib/llm_provider.js';
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
import { resolveAiDisclosure } from './lib/ai_disclosure.js';
import { CaraTools, type CaraAgentUserData } from './lib/cara_tools.js';
import { estimateCallCostUsd } from './lib/call_cost_estimate.js';
import { postprocessCallTranscript } from './lib/call_postprocess.js';
import { insertCallLog, updateCallLogEnrichment } from './lib/call_logs.js';
import {
  buildCloseDiagnosticsPayload,
  createCallLatencyTracker,
} from './lib/call_close_diagnostics.js';
import { createCallDiagnosticSession } from './lib/call_diagnostic_bundle.js';
import {
  assistantTextSoundsLikeFakeHangup,
  assistantTextSoundsLikeGoodbye,
  assistantTextSoundsLikeTerminalHangup,
  buildWarmCallClosingLine,
  disconnectCallerLeg,
  waitForAgentSpeechPlayout,
  waitForSessionPlayout,
  waitForSpeechHandlePlayout,
} from './lib/end_call.js';
import {
  resolveElevenVoiceSettings,
  voiceSettingsCacheFingerprint,
} from './lib/call_participant.js';
import { createElevenLabsTts, isElevenV3Model } from './lib/elevenlabs-v3-http-tts.js';
import { prewarmConfiguredGreetingCaches } from './lib/greeting_prewarm.js';
import { resolveTtsConfig } from './lib/tts_config.js';
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
import {
  classifyPipelineErrorStage,
  postPipelineIncident,
} from './lib/pipeline_incident.js';
import { isTestCall } from './lib/test_call.js';
import { getActiveCallTestProfile } from './lib/test_profile.js';
import {
  detectDemoScenario,
  formatDemoBeatHint,
  type DemoScenario,
} from './lib/demo_scenarios.js';
import {
  demoPlaybookBlockFromScenarios,
  loadDemoScenarios,
} from './lib/demo_scenarios_loader.js';
import { buildDemoCallClosingLine, assistantAskedDemoWrap } from './lib/natural_phrasing.js';
import { caraTypingSoundEnabled, playTypingSound } from './lib/callback_audio.js';
import { persistTestCallReportFromWorker } from './lib/persist_test_call_report.js';
import {
  classifyHelloCaraAboutQuestion,
  helloCaraAboutSteerInstructions,
} from './lib/hello_cara_website_facts.js';
import {
  buildDemoAfterConsentReply,
  buildDemoConversationalReplySteer,
  buildDemoFollowMotivationSteer,
  buildDemoPreNameSteer,
  buildDemoRecordingConsentReply,
  buildDemoRecordingConsentRetrySteer,
  buildDemoRecordingDeclineSteer,
  callerSoundsLikeHelloCaraMotivation,
  extractDemoCallerNameResponse,
} from './lib/demo_personality.js';
import {
  buildDemoCallerReplyNudgeSteer,
  buildDemoNeverSilentSteer,
  buildDemoSilenceWatchdogSteer,
  DEMO_CALLER_REPLY_NUDGE_MS,
  DEMO_REPLY_FAST_GUARANTEE_MS,
  DEMO_SILENCE_WATCHDOG_MS,
  DEMO_THINKING_STALL_MS,
} from './lib/demo_reply_guarantee.js';
import { buildDemoPersonaGreeting, DEMO_LINE_OPENING_PAUSE_MS, pickCallPersona, type CallPersona } from './lib/persona.js';
import { resolveSpokenBusinessName } from './lib/spoken_business_name.js';
import { orgVerticalLabel } from './lib/org_vertical.js';
import { sayPrepared } from './lib/say_prepared.js';
import {
  assistantAskedAnythingElse,
  assistantAwaitingCallerReply,
  assistantClaimsLinkWasSent,
  assistantSoundsLikeCorporateAssist,
  callerAskedNewQuestion,
  callerAsksDemoMenu,
  callerExplicitlyRequestedHangup,
  callerPivotedFromSmsConsent,
  callerSaidNothingElse,
  callerSoundsLikeAffirmativeConsent,
  callerSoundsLikeAudioCheck,
  callerSoundsLikeLineEngagement,
  callerSoundsLikeRecordingDecline,
  callerSoundsLikeVagueDemoOpening,
  callerWindingDownCall,
  assistantSoundsLikeTradeMenu,
  assistantOffersRedundantSampleCall,
} from './lib/speech_triggers.js';
import {
  detectLikelySttGarble,
  isPhantomCallerTranscript,
  soundsLikeBookingIntent,
  soundsLikeCancelOrChangeAppointment,
} from './lib/stt_garble.js';
import { callerSoundsLikeRetailStaffQuestion } from './lib/retail_staff_questions.js';
import {
  callerSoundsLikeWeekdayHoursCorrection,
  callerSoundsLikeOpenHoursQuestion,
  formatStructuredHoursForLivePrompt,
} from './lib/retail_hours.js';
import {
  getOrgForCall,
  getSendableBusinessFiles,
  resolveOrgTimeZone,
  resolveOrgVoiceId,
} from './lib/supabase.js';
import {
  bufferTtsStreamBySentence,
  buildTtsNodeInputStream,
  prepareHardcodedSpeechForTts,
  prepareTextForTtsStreaming,
  setActiveTtsModelForSanitizer,
} from './lib/tts_text_sanitize.js';
import {
  assemblyAiTurnSilenceDefaults,
  buildAssemblyAiSttOptions,
  buildSttDomainPrompt,
  buildSttKeyterms,
  endpointingDefaults,
  isAssemblyAiSttModel,
  isU3RtProSttModel,
  resolveSttLatencyProfile,
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

void reapZombieUsageRows();

const DEFAULT_TEST_PHONE = '+15551234567';
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_TOOL_SNIPPET_CHARS = 800;
const LLM_STALL_MS = 6000;
const CALLER_TRANSCRIPT_DEDUPE_MS = 3000;
const GREETING_INTERRUPT_FALLBACK_MS = 1500;
const GREETING_PLAYBACK_FALLBACK_MS = 800;
const CALLER_REPLY_NUDGE_MS = 2200;

/** Optional slow-tool stall phrases — disabled by default (see LIVEKIT_RESPONSE_FILLER_MS). */
const RESPONSE_FILLER_PHRASES = ['Let me see now…'] as const;

const REPLY_RETRY_INSTRUCTIONS =
  'Your last reply did not reach the caller. React like a person to a dropped line — vary the wording (e.g. "Sorry, you went quiet there — are you still with me?" or "Ah, the line dipped on me — where were we?"). One short warm line that acknowledges what they asked, then continue. No service menu.';

/** Tools that may block on HTTP/SMS — only these arm the thinking micro-ack. */
const SLOW_TOOL_ACK_NAMES = new Set([
  'sendDirectionsLink',
  'sendRoutingLink',
  'sendRoutingFile',
  'searchBusinessFile',
  'takeCallbackMessage',
  'transferToTeam',
]);

function normalizeSpokenLine(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ');
}

function lineMatchesGreeting(text: string, greeting: string): boolean {
  if (!greeting.trim()) return false;
  const a = normalizeSpokenLine(text);
  const b = normalizeSpokenLine(greeting);
  if (a === b) return true;
  if (a.length > 24 && b.length > 24) {
    const head = b.slice(0, Math.min(48, b.length));
    return a.includes(head) || b.includes(a.slice(0, Math.min(48, a.length)));
  }
  return false;
}

function assistantAskedForPhoneNumber(text: string): boolean {
  return /\b((?:your |the )?phone number|what(?:'s| is) your number|provide (?:me with )?(?:your )?(?:phone )?number|mobile number|contact number|number you(?:'re| are) calling from|give me your number)\b/i.test(
    text,
  );
}

function assistantAskedForCallerIdentity(text: string): boolean {
  return /\b(take your name|your name and number|name and number|what(?:'s| is) your name|can i take your name|may i take your name|who am i speaking to)\b/i.test(
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
    void prewarmConfiguredGreetingCaches().catch((e) => {
      console.warn('[agent] greeting_prewarm_failed', e);
    });
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
      resolveCalledNumber(routing.phone, org.phone_number) ||
      org.phone_number?.trim() ||
      '';
    const testCall =
      isTestCall(calledNumber) ||
      isTestCall(routing.phone) ||
      isTestCall(org.phone_number);
    const testProfile = testCall ? await getActiveCallTestProfile() : null;
    const demoScenarios: DemoScenario[] = testCall ? await loadDemoScenarios() : [];
    if (testCall) {
      console.info('[agent] test_call', {
        calledNumber: maskPhone(calledNumber),
        profile: testProfile?.name ?? '(none)',
      });
    }
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

    const ttsConfig = resolveTtsConfig({
      testProfile,
      orgVoiceId: resolveOrgVoiceId(org),
    });
    const useCartesiaInference = ttsConfig.provider === 'cartesia-inference';
    const activeTtsModel = ttsConfig.model;
    const activeVoiceId = ttsConfig.voiceId;
    const elevenModel = useCartesiaInference
      ? activeTtsModel
      : (activeTtsModel as elevenlabs.TTSModels);

    const greetingText = org.greeting?.trim() ?? '';
    const spokenBusinessName = resolveSpokenBusinessName({
      name: org.name,
      greeting: org.greeting,
    });

    const structuredHoursBlock =
      org.niche === 'retail'
        ? formatStructuredHoursForLivePrompt(org.business_hours, bookingTz, todayLocal)
        : null;

    const orgVertical = orgVerticalLabel({
      niche: org.niche,
      businessType: org.agent_business_type,
    });

    let callPersona: CallPersona | undefined;
    const personaSeed = `${org.id}:${callerNumberRaw}:${ctx.room.name || 'room'}`;
    let localHour: number | undefined;
    try {
      localHour = Number.parseInt(
        new Intl.DateTimeFormat('en-IE', {
          hour: 'numeric',
          hour12: false,
          timeZone: bookingTz,
        }).format(new Date()),
        10,
      );
    } catch {
      localHour = undefined;
    }
    callPersona = pickCallPersona({
      businessName: testCall ? 'Hello Cara' : spokenBusinessName,
      seed: personaSeed,
      ...(localHour != null && Number.isFinite(localHour) ? { localHour } : {}),
    });
    const useDemoPersonaGreeting = testCall;
    const playbackGreetingText =
      useDemoPersonaGreeting && callPersona
        ? buildDemoPersonaGreeting(callPersona, personaSeed)
        : greetingText;
    const skipGreetingCache = useDemoPersonaGreeting && Boolean(playbackGreetingText);
    console.info('[agent] call_persona', {
      variant: callPersona.variant,
      demoLine: testCall,
      greetingPreview: playbackGreetingText.slice(0, 80),
      personaGreeting: useDemoPersonaGreeting,
    });

    const systemPrompt = buildCaraCallPrompt({
      businessName: spokenBusinessName,
      customPrompt: custom,
      callerLine,
      routingLinks,
      bookingTimeZone: bookingTz,
      nowUtcIso,
      todayLocal,
      ttsModel: activeTtsModel,
      niche: org.niche,
      businessType: org.agent_business_type,
      openingGreetingDelivered: Boolean(playbackGreetingText),
      structuredHoursBlock,
      demoMode: testCall,
      ...(callPersona ? { persona: callPersona } : {}),
      ...(testCall
        ? { demoPlaybookBlock: demoPlaybookBlockFromScenarios(demoScenarios) }
        : {}),
    });

    console.info('[agent] organization loaded', {
      id: org.id,
      slug: org.slug,
      name: org.name,
      phone: maskPhone(org.phone_number),
      calledNumber: maskPhone(calledNumber),
      niche: org.niche,
      promptChars: org.custom_prompt?.length ?? 0,
      systemPromptChars: systemPrompt.length,
      orgVertical,
      greetingSet: Boolean(org.greeting?.trim()),
      routeCount: routingLinks.length,
    });

    const callStartedAt = Date.now();
    const diag = createCallDiagnosticSession();
    const latencyTracker = createCallLatencyTracker(callStartedAt);
    let greetingPlayedFlag = false;
    let greetingSource: 'cached_pcm' | 'live_tts' | null = null;
    const pipelineIncidentPosted = new Set<string>();
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
    if (typeof planQuota === 'number' && planQuota > 0 && !testCall) {
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

    const usageRecordIdPromise = testCall
      ? Promise.resolve(null)
      : startUsageRecord({
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
        demoCallerReadyToClose: false,
        demoScenarioSlug: null,
        demoScenarioBeat: 0,
        demoCallerName: null,
        demoNameBanterUsed: false,
        demoPostNameSteerUsed: false,
        demoRecordingConsentAsked: false,
        demoChitchatOpened: false,
        demoPersonalityNameAskUsed: false,
      },
      disclosureConfirmed: greetingIncludesAiDisclosure(greetingText),
      demoLine: testCall,
      ...(callPersona ? { callPersona } : {}),
      ...(endCallTarget ? { endCallTarget } : {}),
    };

    const elevenApiKey =
      process.env.ELEVEN_API_KEY?.trim() || process.env.ELEVENLABS_API_KEY?.trim() || '';
    if (!useCartesiaInference && !elevenApiKey) {
      console.error('[agent] ELEVENLABS_API_KEY (or ELEVEN_API_KEY) is required for ElevenLabs TTS');
      ctx.shutdown('missing_elevenlabs_key');
      return;
    }

    const inferenceSttModel =
      testProfile?.stt_model?.trim() ||
      process.env.LIVEKIT_INFERENCE_STT_MODEL?.trim() ||
      'assemblyai/u3-rt-pro';
    const inferenceSttLanguage = process.env.LIVEKIT_INFERENCE_STT_LANGUAGE?.trim() || 'en';
    const inferenceLlmModel =
      testProfile?.llm_model?.trim() ||
      process.env.LIVEKIT_INFERENCE_LLM_MODEL?.trim() ||
      (testCall ? 'openai/gpt-4o-mini' : 'openai/gpt-4.1');

    const elevenVoiceId = activeVoiceId;
    const elevenEncoding = process.env.ELEVEN_TTS_ENCODING?.trim() || 'pcm_24000';
    const elevenBaseUrl =
      process.env.ELEVENLABS_BASE_URL?.trim() || 'https://api.elevenlabs.io/v1';
    const elevenVoiceSettings = resolveElevenVoiceSettings();
    const greetingCacheKey =
      !useCartesiaInference && playbackGreetingText && !skipGreetingCache
        ? greetingAudioCacheKey(
            org.id,
            playbackGreetingText,
            elevenVoiceId,
            voiceSettingsCacheFingerprint(elevenVoiceSettings),
          )
        : null;

    const greetingCacheWarmPromise =
      !useCartesiaInference && playbackGreetingText && !skipGreetingCache && elevenApiKey
        ? ensureGreetingPcmCached({
            orgId: org.id,
            greetingText: playbackGreetingText,
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
            diag.push('info', 'greeting_pcm_warm', {
              bytes: pcm.byteLength,
              msSinceCallStart: Date.now() - callStartedAt,
            });
          })
          .catch((e) => {
            console.error('[agent] greeting pcm warmup failed', e);
            diag.push('error', 'greeting_pcm_warm_failed', {
              message: e instanceof Error ? e.message : String(e),
            });
          })
      : null;

    const isU3RtProStt = isU3RtProSttModel(inferenceSttModel);
    // u3-rt-pro: LiveKit turn detector + tuned silence — STT-owned EOT interrupts TTS mid-reply.
    const useSttNeuralTurnDetection =
      !isU3RtProStt && process.env.LIVEKIT_STT_NEURAL_TURN?.trim() === '1';
    const latencyProfile = resolveSttLatencyProfile(process.env.LIVEKIT_STT_LATENCY_PROFILE);
    const silenceDefaults = assemblyAiTurnSilenceDefaults(inferenceSttModel, latencyProfile);
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
      : testCall
        ? Number.parseInt(process.env.LIVEKIT_TEST_ENDPOINTING_MAX_MS ?? '700', 10)
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

    const interruptionMinMs = Number.parseInt(
      process.env.LIVEKIT_INTERRUPTION_MIN_MS ??
        (testCall ? '450' : '200'),
      10,
    );
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
      customPrompt: testCall ? null : org.custom_prompt,
      extraTerms: envExtraKeyterms,
      niche: testCall ? 'other' : org.niche,
      businessType: testCall ? 'Hello Cara demo line' : org.agent_business_type,
    });
    const sttDomainPrompt =
      process.env.LIVEKIT_STT_DOMAIN_PROMPT?.trim() ||
      (testCall
        ? 'Irish English phone calls to Hello Cara. Callers explore the AI assistant — no real shop hours, bookings, or business facts.'
        : buildSttDomainPrompt(org.name, {
            niche: org.niche,
            businessType: org.agent_business_type,
          }));
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

    // 0.7 adds phrasing variety; still reliable for tool selection on gpt-4o-mini / gpt-5-mini.
    const llmTemperature = Number.parseFloat(process.env.LIVEKIT_LLM_TEMPERATURE ?? '0.7');
    const llmMaxCompletionTokens = Number.parseInt(process.env.LIVEKIT_LLM_MAX_TOKENS ?? '320', 10);

    const resolvedLlm = createCaraLlm({
      inferenceLlmModel,
      profileLlmProvider: testProfile?.llm_provider ?? null,
      temperature: llmTemperature,
      maxCompletionTokens: llmMaxCompletionTokens,
    });
    const llmInstance = resolvedLlm.instance;

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

    const pipelineLabel = {
      stt: inferenceSttModel,
      sttKeytermCount: sttKeyterms.length,
      sttNeuralTurn: useSttNeuralTurnDetection,
      latencyProfile,
      llm: resolvedLlm.label,
      tts: ttsConfig.label,
      voiceId: activeVoiceId,
      ttsProvider: ttsConfig.provider,
      endpointMinMs,
      endpointMaxMs,
    };

    const configSnapshot = {
      testProfile: testProfile
        ? {
            id: testProfile.id,
            name: testProfile.name,
            voice_id: testProfile.voice_id,
            llm_model: testProfile.llm_model,
            stt_model: testProfile.stt_model,
            tts_model: testProfile.tts_model,
            llm_provider: testProfile.llm_provider,
          }
        : null,
      llmProvider: resolvedLlm.provider,
      llmTemperature,
      llmMaxCompletionTokens,
      elevenStreamingLatency:
        Number.parseInt(process.env.ELEVEN_STREAMING_LATENCY ?? '1', 10) || 1,
      elevenEncoding,
      endpointMode,
      interruptionMode,
      latencyProfile,
      sttLanguage: inferenceSttLanguage,
      greetingCacheKey: greetingCacheKey ?? null,
    };

    console.info('[agent] pipeline', pipelineLabel);
    diag.setPipeline(pipelineLabel);
    diag.setIdentifiers({
      organizationId: org.id,
      calledNumber,
      callSid: callSidAttr,
      roomName: roomName || null,
      livekitJobId,
      disclosureConfirmed: sessionUserData.disclosureConfirmed,
    });
    if (testCall) {
      diag.push('info', 'test_call', {
        profileId: testProfile?.id ?? null,
        variantLabel: testProfile?.name ?? null,
      });
    }

    setActiveTtsModelForSanitizer(activeTtsModel);

    const sessionTts = useCartesiaInference
      ? new inference.TTS({
          model: ttsConfig.model,
          voice: ttsConfig.voiceId,
          language: ttsConfig.language,
        })
      : createElevenLabsTts({
          apiKey: elevenApiKey,
          voiceId: elevenVoiceId,
          model: elevenModel as elevenlabs.TTSModels,
          encoding: elevenEncoding as elevenlabs.TTSEncoding,
          baseURL: elevenBaseUrl,
          streamingLatency: Number.parseInt(process.env.ELEVEN_STREAMING_LATENCY ?? '1', 10) || 1,
          voiceSettings: resolveElevenVoiceSettings(),
        });

    const session = new voice.AgentSession<CaraAgentUserData>({
      stt: new inference.STT({
        model: inferenceSttModel,
        language: inferenceSttLanguage,
        modelOptions: sttModelOptions,
      }),
      vad: ctx.proc.userData.vad as silero.VAD,
      llm: llmInstance,
      tts: sessionTts,
      userData: sessionUserData,
      maxToolSteps: 5,
      turnHandling: {
        preemptiveGeneration: {
          enabled: testCall
            ? process.env.LIVEKIT_TEST_PREEMPTIVE_GENERATION?.trim() === '1'
            : process.env.LIVEKIT_PREEMPTIVE_GENERATION?.trim() === '1',
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

    const deadAirMs = testCall
      ? Number.parseInt(process.env.DEMO_DEAD_AIR_MS ?? '6000', 10)
      : Number.parseInt(process.env.LIVEKIT_DEAD_AIR_MS ?? '10000', 10);
    const deadAirCloseMs = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_CLOSE_MS ?? '8000', 10);
    const deadAirMaxPrompts = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_MAX_PROMPTS ?? '2', 10);
    const responseFillerMs = Number.parseInt(
      process.env.LIVEKIT_RESPONSE_FILLER_MS ?? (testCall ? '1000' : '0'),
      10,
    );
    const responseFillerMaxPerCall = Number.parseInt(
      process.env.LIVEKIT_RESPONSE_FILLER_MAX_PER_CALL ?? '3',
      10,
    );
    const postGreetingGraceMs = testCall
      ? Number.parseInt(process.env.LIVEKIT_TEST_POST_GREETING_GRACE_MS ?? '3500', 10)
      : Number.parseInt(process.env.LIVEKIT_POST_GREETING_GRACE_MS ?? '5000', 10);
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
    let callerReplyNudgeTimer: ReturnType<typeof setTimeout> | null = null;
    let demoFastGuaranteeTimer: ReturnType<typeof setTimeout> | null = null;
    let demoSilenceWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let callerAwaitingReply = false;
    let replyTurnEpoch = 0;
    let replyRetryUsedForTurn = false;
    let generateReplyInFlight = false;
    let generateReplyStartedAt = 0;
    let allowBookingAutomation = false;
    let greetingPlaybackStarted = false;
    let greetingAudioSpeechPending = 0;
    let greetingTranscriptLogged = false;
    let greetingPlayoutComplete = false;
    let lastAssistantSpeechHandle: {
      done(): boolean;
      addDoneCallback: (cb: (sh: unknown) => void) => void;
    } | null = null;
    let listenGraceUntil = 0;
    let callerHasFinalTranscript = false;
    let lastAssistantChatText = '';
    let lastAssistantSpokeAt = 0;
    let corporateAssistCorrectedEpoch = -1;
    let programmaticSpeechPending = 0;
    let lastCallerUtterance = '';
    let llmReplySpeechQueued = false;
    let demoSteerHandledThisTurn = false;
    let demoCallerTurnPendingAnswer = false;

    let thinkingStartedAt: number | null = null;
    let userStoppedSpeakingAt: number | null = null;

    const transcriptParts: TranscriptLine[] = [];
    let transcriptSeq = 0;
    const recentCallerTranscripts = new Map<string, number>();

    const normalizeTranscriptKey = (text: string) =>
      text
        .trim()
        .toLowerCase()
        .replace(/[^\w\s']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

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

    const cancelInFlightReply = () => {
      try {
        session.interrupt();
      } catch {
        /* ignore */
      }
      generateReplyInFlight = false;
      generateReplyStartedAt = 0;
    };

    const steerReply = (instructions: string) => {
      if (isCallEnding()) return;
      demoSteerHandledThisTurn = true;
      clearDemoReplyGuaranteeTimers();
      clearCallerReplyNudgeTimer();
      cancelInFlightReply();
      safeGenerateReply(instructions, { force: true, skipBeatHint: true });
    };

    const appendDemoBeatHint = (instructions: string): string => {
      if (!testCall) return instructions;
      if (/\[Demo playbook/i.test(instructions)) return instructions;
      const slug = session.userData.sessionFlags.demoScenarioSlug;
      const beat = session.userData.sessionFlags.demoScenarioBeat ?? 0;
      if (!slug || beat <= 0) return instructions;
      const hint = formatDemoBeatHint(slug, beat - 1, demoScenarios);
      if (!hint) return instructions;
      return `${instructions}\n\n${hint}`;
    };

    const safeGenerateReply = (
      instructions: string,
      opts?: { force?: boolean; skipBeatHint?: boolean },
    ) => {
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
      const steeredInstructions = opts?.skipBeatHint
        ? instructions
        : appendDemoBeatHint(instructions);
      const handle = session.generateReply({ instructions: steeredInstructions });
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
      if (!testCall && inListenGrace()) return false;
      return true;
    };

    const callerAlreadyAnsweredSince = (callerAt: number): boolean =>
      lastAssistantSpokeAt >= callerAt;

    const forceDemoReply = (instructions: string, reason: string) => {
      if (isCallEnding()) return;
      console.warn('[agent] demo_force_reply', {
        reason,
        snippet: lastCallerUtterance.slice(0, 80),
      });
      diag.push('warn', 'demo_force_reply', {
        reason,
        snippet: lastCallerUtterance.slice(0, 120),
      });
      cancelInFlightReply();
      generateReplyInFlight = false;
      generateReplyStartedAt = 0;
      replyRetryUsedForTurn = false;
      safeGenerateReply(instructions, { force: true });
    };

    const clearDemoReplyGuaranteeTimers = () => {
      if (demoFastGuaranteeTimer) {
        clearTimeout(demoFastGuaranteeTimer);
        demoFastGuaranteeTimer = null;
      }
      if (demoSilenceWatchdogTimer) {
        clearTimeout(demoSilenceWatchdogTimer);
        demoSilenceWatchdogTimer = null;
      }
    };

    const scheduleDemoReplyGuarantee = (callerText: string) => {
      if (!testCall || isCallEnding()) return;
      clearDemoReplyGuaranteeTimers();
      const epoch = replyTurnEpoch;
      const callerAt = Date.now();
      const utterance = callerText.trim();
      if (!utterance) return;

      demoFastGuaranteeTimer = setTimeout(() => {
        demoFastGuaranteeTimer = null;
        if (epoch !== replyTurnEpoch || isCallEnding()) return;
        if (callerAlreadyAnsweredSince(callerAt)) return;
        if (session.userState === 'speaking') return;
        if (session.agentState === 'speaking' || session.agentState === 'thinking') return;
        forceDemoReply(buildDemoNeverSilentSteer(utterance), 'fast_guarantee');
      }, DEMO_REPLY_FAST_GUARANTEE_MS);

      demoSilenceWatchdogTimer = setTimeout(() => {
        demoSilenceWatchdogTimer = null;
        if (epoch !== replyTurnEpoch || isCallEnding()) return;
        if (callerAlreadyAnsweredSince(callerAt)) return;
        if (session.userState === 'speaking') return;
        if (session.agentState === 'speaking' || session.agentState === 'thinking') return;
        forceDemoReply(buildDemoSilenceWatchdogSteer(utterance), 'silence_watchdog');
      }, DEMO_SILENCE_WATCHDOG_MS);
    };

    const retryFailedReplyOnce = (source: string) => {
      if (replyRetryUsedForTurn || isCallEnding()) return;
      if (!canPlayRecoverySpeech()) return;
      if (session.userState === 'speaking') return;
      replyRetryUsedForTurn = true;
      console.warn('[agent] reply_retry', { source, epoch: replyTurnEpoch });
      const instructions = testCall
        ? buildDemoSilenceWatchdogSteer(lastCallerUtterance)
        : REPLY_RETRY_INSTRUCTIONS;
      safeGenerateReply(instructions, { force: true });
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
      const stage = classifyPipelineErrorStage(msg);
      diag.push('error', `pipeline_${stage}_error`, { message: msg, stage });
      const incidentKey = `${stage}:${msg.slice(0, 120)}`;
      if (!pipelineIncidentPosted.has(incidentKey)) {
        pipelineIncidentPosted.add(incidentKey);
        void postPipelineIncident({
          organizationId: org.id,
          calledNumber,
          callerNumber: callerNumberRaw,
          roomName: roomName || null,
          callSid: callSidAttr,
          stage,
          errorMessage: msg,
          modelLabel:
            stage === 'tts'
              ? String(elevenModel)
              : stage === 'llm'
                ? resolvedLlm.label
                : inferenceSttModel,
          retryable: true,
        });
      }
      retryFailedReplyOnce('pipeline_error');
    });

    const clearCallerReplyNudgeTimer = () => {
      if (callerReplyNudgeTimer) {
        clearTimeout(callerReplyNudgeTimer);
        callerReplyNudgeTimer = null;
      }
    };

    const scheduleCallerReplyNudge = () => {
      clearCallerReplyNudgeTimer();
      if (!allowBookingAutomation || isCallEnding()) return;
      const epoch = replyTurnEpoch;
      const utterance = lastCallerUtterance.trim();
      if (!utterance) return;
      const callerAt = Date.now();
      const nudgeMs = testCall ? DEMO_CALLER_REPLY_NUDGE_MS : CALLER_REPLY_NUDGE_MS;
      callerReplyNudgeTimer = setTimeout(() => {
        callerReplyNudgeTimer = null;
        if (epoch !== replyTurnEpoch || isCallEnding()) return;
        if (testCall) {
          if (callerAlreadyAnsweredSince(callerAt)) return;
          if (session.userState === 'speaking') return;
          if (session.agentState === 'speaking') return;
          const thinkingInProgress =
            session.agentState === 'thinking' &&
            generateReplyInFlight &&
            Date.now() - generateReplyStartedAt < DEMO_THINKING_STALL_MS;
          if (thinkingInProgress) return;
          if (session.agentState === 'listening' && generateReplyInFlight) return;
        } else {
          if (session.agentState !== 'listening' || session.userState === 'speaking') return;
          if (generateReplyInFlight) return;
        }
        console.warn('[agent] caller_reply_nudge', { utterance: utterance.slice(0, 80) });
        const instructions = testCall
          ? buildDemoCallerReplyNudgeSteer(utterance)
          : `The caller said: "${utterance.slice(0, 200)}". Reply in **one short spoken sentence** (~25 words max). ` +
            'Do not repeat your opening greeting or any AI/recording disclosure. ' +
            'Do not say "grand". If they asked whether you can hear them, say yes warmly and ask how you can help.';
        if (testCall) {
          forceDemoReply(instructions, 'caller_reply_nudge');
        } else {
          safeGenerateReply(instructions, { force: true });
        }
      }, nudgeMs);
    };

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
      } else if (reason === 'greeting_completed' && playbackGreetingText.trim() && !greetingTranscriptLogged) {
        greetingTranscriptLogged = true;
        appendTranscriptLine(Date.now(), `Assistant: ${playbackGreetingText.trim()}`);
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
      demoSteerHandledThisTurn = false;
      if (testCall && allowBookingAutomation) {
        demoCallerTurnPendingAnswer = true;
      }
      lastCallerUtterance = text.trim();
      if (isPhantomCallerTranscript(text)) {
        console.info('[agent] noise_fragment_ignored', {
          snippet: text.slice(0, 60),
          reason: bumpReason,
        });
        return false;
      }
      const key = normalizeTranscriptKey(text);
      if (isDuplicateCallerUtterance(key, at)) return false;
      settleGreetingPhase('caller_spoke');
      appendTranscriptLine(at, `Caller: ${text}`);
      session.userData.sessionFlags.likelySttGarble = false;
      noteCallerGarble(session.userData.sessionFlags, session.userData.organizationId, text);
      resetClosePhaseIfCallerContinues(text);
      noteCallerTurnNeedsReply(text);
      if (session.userData.sessionFlags.awaitingAnythingElseReply) {
        session.userData.sessionFlags.callerRespondedAfterAnythingElse = true;
      }
      if (soundsLikeCancelOrChangeAppointment(text)) {
        session.userData.sessionFlags.bookingRouteId = null;
      }
      if (
        testCall &&
        (callerWindingDownCall(text) || callerExplicitlyRequestedHangup(text))
      ) {
        session.userData.sessionFlags.demoCallerReadyToClose = true;
      }
      if (testCall) {
        const flags = session.userData.sessionFlags;
        const detected = detectDemoScenario(text, demoScenarios);
        if (detected && !flags.demoScenarioSlug) {
          flags.demoScenarioSlug = detected;
          flags.demoScenarioBeat = 1;
          diag.push('info', 'demo_scenario_start', {
            slug: detected,
            snippet: text.slice(0, 120),
          });
        }
      }
      if (
        org.niche === 'retail' &&
        callerSoundsLikeOpenHoursQuestion(text) &&
        !session.userData.sessionFlags.endPhoneCallUsed
      ) {
        steerReply(
          'The caller is asking about store opening hours. Use Structured hours in your instructions. Answer for the day they mean in one warm line — store hours, not whether you as an AI will be available.',
        );
      } else if (
        org.niche === 'retail' &&
        callerSoundsLikeRetailStaffQuestion(text) &&
        !session.userData.sessionFlags.endPhoneCallUsed
      ) {
        steerReply(
          'The caller is asking about a store or department manager (their speech may be garbled). Answer from your business instructions — store manager, fresh food manager, ambient manager. This is a simple info question: do NOT ask for their name or phone number and do NOT offer to take a message unless they explicitly want a callback.',
        );
      } else if (
        org.niche === 'retail' &&
        callerSoundsLikeWeekdayHoursCorrection(text) &&
        !session.userData.sessionFlags.endPhoneCallUsed
      ) {
        steerReply(
          'The caller is correcting opening hours. Use Structured hours in your instructions. Apologise briefly and give the correct weekday hours — do not treat a normal weekday as a bank holiday.',
        );
      } else if (
        session.userData.sessionFlags.likelySttGarble &&
        soundsLikeBookingIntent(text) &&
        allowBookingAutomation
      ) {
        void safeGenerateReply(
          'That last utterance may be STT garble — do not treat it as a confirmed booking request. Ask one short clarifying question about what they need.',
        );
      } else if (
        testCall &&
        session.userData.sessionFlags.demoRecordingConsentAsked &&
        !session.userData.sessionFlags.demoChitchatOpened &&
        !isCallEnding()
      ) {
        const flags = session.userData.sessionFlags;
        const name = flags.demoCallerName ?? 'there';
        if (callerSoundsLikeAffirmativeConsent(text)) {
          flags.demoChitchatOpened = true;
          session.userData.disclosureConfirmed = true;
          diag.push('info', 'demo_after_consent_reply', { name });
          programmaticSpeechPending += 1;
          sayPrepared(session, buildDemoAfterConsentReply(name), {
            allowInterruptions: true,
            addToChatCtx: true,
          });
          demoSteerHandledThisTurn = true;
        } else if (callerSoundsLikeRecordingDecline(text)) {
          steerReply(buildDemoRecordingDeclineSteer());
        } else {
          steerReply(buildDemoRecordingConsentRetrySteer());
        }
      } else if (
        testCall &&
        classifyHelloCaraAboutQuestion(text) &&
        session.userData.sessionFlags.demoChitchatOpened &&
        !isCallEnding()
      ) {
        const about = classifyHelloCaraAboutQuestion(text)!;
        const flags = session.userData.sessionFlags;
        if (!flags.demoScenarioSlug) {
          flags.demoScenarioSlug = 'general';
          flags.demoScenarioBeat = about === 'who-made' ? 2 : 1;
          diag.push('info', 'demo_scenario_start', {
            slug: 'general',
            snippet: text.slice(0, 120),
            about,
          });
        }
        steerReply(helloCaraAboutSteerInstructions(about));
      } else if (
        testCall &&
        callerAsksDemoMenu(text) &&
        session.userData.sessionFlags.demoChitchatOpened &&
        !session.userData.sessionFlags.demoScenarioSlug &&
        !isCallEnding()
      ) {
        const flags = session.userData.sessionFlags;
        flags.demoScenarioSlug = 'general';
        flags.demoScenarioBeat = 1;
        diag.push('info', 'demo_scenario_start', {
          slug: 'general',
          snippet: text.slice(0, 120),
        });
        steerReply(
          'The caller asked what they can demo. ONE warm conversational line (~18 words). Do NOT list trades. Continue naturally — reflect the chat so far, then gently explore what kind of business they have in mind.',
        );
      } else if (
        testCall &&
        !session.userData.sessionFlags.demoPostNameSteerUsed &&
        !session.userData.sessionFlags.demoScenarioSlug &&
        !isCallEnding() &&
        !classifyHelloCaraAboutQuestion(text) &&
        !callerAsksDemoMenu(text) &&
        !detectDemoScenario(text, demoScenarios) &&
        !callerSoundsLikeHelloCaraMotivation(text)
      ) {
        const flags = session.userData.sessionFlags;
        const volunteeredName = extractDemoCallerNameResponse(text);
        if (volunteeredName) {
          flags.demoCallerName = volunteeredName;
          flags.demoNameBanterUsed = true;
          flags.demoPostNameSteerUsed = true;
          flags.demoRecordingConsentAsked = true;
          diag.push('info', 'demo_recording_consent_reply', { name: volunteeredName });
          programmaticSpeechPending += 1;
          sayPrepared(session, buildDemoRecordingConsentReply(volunteeredName), {
            allowInterruptions: true,
            addToChatCtx: true,
          });
          demoSteerHandledThisTurn = true;
        } else if (callerSoundsLikeAudioCheck(text)) {
          flags.demoPostNameSteerUsed = true;
          diag.push('info', 'demo_pre_name_steer', { kind: 'audio_check' });
          steerReply(buildDemoPreNameSteer({ audioCheck: true }));
        } else if (callerSoundsLikeLineEngagement(text)) {
          flags.demoPostNameSteerUsed = true;
          diag.push('info', 'demo_pre_name_steer', { kind: 'opening_reply' });
          steerReply(buildDemoPreNameSteer());
        }
      } else if (
        testCall &&
        session.userData.sessionFlags.demoChitchatOpened &&
        !session.userData.sessionFlags.demoScenarioSlug &&
        callerSoundsLikeVagueDemoOpening(text) &&
        !isCallEnding()
      ) {
        steerReply(buildDemoConversationalReplySteer(text));
      } else if (
        testCall &&
        session.userData.sessionFlags.demoChitchatOpened &&
        !session.userData.sessionFlags.demoScenarioSlug &&
        !callerSoundsLikeVagueDemoOpening(text) &&
        !callerAsksDemoMenu(text) &&
        !classifyHelloCaraAboutQuestion(text) &&
        !isCallEnding() &&
        (callerSoundsLikeHelloCaraMotivation(text) || detectDemoScenario(text, demoScenarios))
      ) {
        const flags = session.userData.sessionFlags;
        const detected = detectDemoScenario(text, demoScenarios);
        flags.demoScenarioSlug = detected ?? 'general';
        flags.demoScenarioBeat = 1;
        diag.push('info', 'demo_motivation_steer', {
          slug: flags.demoScenarioSlug,
          snippet: text.slice(0, 120),
        });
        steerReply(buildDemoFollowMotivationSteer(text, detected));
      } else if (
        testCall &&
        !isCallEnding()
      ) {
        const flags = session.userData.sessionFlags;
        if (
          flags.demoScenarioSlug &&
          (flags.demoScenarioBeat ?? 0) === 3 &&
          caraTypingSoundEnabled()
        ) {
          playTypingSound(session);
        }
      }
      if (callerPivotedFromSmsConsent(text, { awaitingSmsConsent: session.userData.sessionFlags.bookingLinkSendInFlight })) {
        session.userData.sessionFlags.bookingRouteId = null;
        diag.push('warn', 'booking_consent_pivot', { snippet: text.slice(0, 120) });
        steerReply(
          'The caller pivoted away from SMS consent — stop treating their last line as yes/no to texting. Answer their new question or offer a callback.',
        );
      }
      maybeCloseAfterAnythingElse(text);
      if (testCall && session.userData.sessionFlags.demoCallerReadyToClose) {
        maybeCloseDemoCall();
      }
      if (!demoSteerHandledThisTurn) {
        scheduleCallerReplyNudge();
        if (testCall) {
          scheduleDemoReplyGuarantee(text);
        }
      }
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
          const closingLine = testCall
            ? buildDemoCallClosingLine(callSidAttr)
            : buildWarmCallClosingLine(
                {
                  name: org.name,
                  greeting: org.greeting,
                },
                callSidAttr,
              );
          const handle = sayPrepared(session, closingLine, {
            allowInterruptions: false,
          });
          await waitForSpeechHandlePlayout(handle);
          await disconnectCallerLeg(session, session.userData, async () => {});
        } catch (e) {
          console.error('[AgentSession] auto close after anything-else failed', e);
        }
      })();
    };

    const maybeCloseDemoCall = () => {
      const flags = session.userData.sessionFlags;
      if (!testCall || !flags.demoCallerReadyToClose) return;
      if (flags.endPhoneCallUsed || flags.closingCall) return;

      flags.closingCall = true;
      clearAllGuardTimers();
      try {
        session.interrupt();
      } catch {
        /* ignore */
      }
      void (async () => {
        try {
          const handle = sayPrepared(session, buildDemoCallClosingLine(callSidAttr), {
            allowInterruptions: false,
          });
          await waitForSpeechHandlePlayout(handle);
          await disconnectCallerLeg(session, session.userData, async () => {});
        } catch (e) {
          console.error('[AgentSession] auto close demo call failed', e);
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
      clearCallerReplyNudgeTimer();
      clearDemoReplyGuaranteeTimers();
    };

    const resetDeadAirTimer = () => {
      clearDeadAirTimers();
      if (isCallEnding()) return;
      const f = session.userData.sessionFlags;
      if (f.askedAnythingElse && f.callerRespondedAfterAnythingElse) return;
      if (f.bookingLinkSendInFlight) return;
      if (callerAwaitingReply) return;
      if (inListenGrace() && !testCall) return;
      deadAirTimer = setTimeout(() => {
        deadAirTimer = null;
        try {
          if (isCallEnding()) return;
          if (callerAwaitingReply) return;
          if (inListenGrace() && !testCall) return;
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
        if (ev.oldState !== 'speaking' && allowBookingAutomation) {
          if (session.agentState === 'thinking' || session.agentState === 'speaking') {
            bumpReplyTurn('caller_barge_in');
          } else if (session.agentState === 'listening') {
            // New caller turn — bump at utterance start so preemptive + auto-reply share the same epoch.
            bumpReplyTurn('caller_new_turn');
          }
        }
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState === 'speaking') {
        clearResponseFillerTimer();
        clearCallerReplyNudgeTimer();
        clearDemoReplyGuaranteeTimers();
      } else if (ev.newState === 'listening') {
        clearResponseFillerTimer();
        if (!testCall) {
          clearCallerReplyNudgeTimer();
        }
      }
      if (ev.newState === 'thinking' || ev.newState === 'speaking') {
        clearGreetingInterruptFallbackTimer();
      }
      if (ev.newState === 'speaking') {
        lastAssistantSpokeAt = Date.now();
        latencyTracker.recordFirstAudio();
        if (thinkingStartedAt !== null) {
          const replyMs = Date.now() - thinkingStartedAt;
          console.info('[agent] thinking_to_speaking_ms', replyMs);
          latencyTracker.recordReplyLatency(replyMs);
          diag.push('info', 'thinking_to_speaking_ms', { ms: replyMs });
          thinkingStartedAt = null;
        }
      } else if (ev.newState === 'thinking' && !isCallEnding()) {
        if (userStoppedSpeakingAt !== null) {
          const userToThinkingMs = Date.now() - userStoppedSpeakingAt;
          console.info(
            '[agent] user_speaking_to_thinking_ms',
            userToThinkingMs,
          );
          latencyTracker.recordUserToThinking(userToThinkingMs);
          diag.push('info', 'user_speaking_to_thinking_ms', { ms: userToThinkingMs });
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
      lastAssistantSpeechHandle = ev.speechHandle;
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
          } else if (programmaticSpeechPending > 0) {
            programmaticSpeechPending -= 1;
          }
          return;
        }
        if (!allowBookingAutomation) {
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
            callerSnippet: lastCallerUtterance.slice(0, 120),
          });
          diag.push('error', 'empty_speech_handle', {
            callerSnippet: lastCallerUtterance.slice(0, 120),
          });
          retryFailedReplyOnce('empty_speech_handle');
          return;
        }
        if (lastAssistantChatText.trim()) {
          lastAssistantChatText = '';
        }
      });
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
      if (testCall && role === 'assistant' && assistantAskedDemoWrap(text)) {
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
        testCall &&
        role === 'assistant' &&
        allowBookingAutomation &&
        demoCallerTurnPendingAnswer &&
        !item.interrupted &&
        text.length > 3 &&
        flags.demoScenarioSlug &&
        (flags.demoScenarioBeat ?? 0) > 0 &&
        (flags.demoScenarioBeat ?? 0) < 4 &&
        !lineMatchesGreeting(text, playbackGreetingText)
      ) {
        demoCallerTurnPendingAnswer = false;
        flags.demoScenarioBeat = Math.min(4, (flags.demoScenarioBeat ?? 0) + 1);
        diag.push('info', 'demo_scenario_beat', {
          slug: flags.demoScenarioSlug,
          beat: flags.demoScenarioBeat,
        });
      }
      if (
        testCall &&
        role === 'assistant' &&
        assistantSoundsLikeTradeMenu(text) &&
        !flags.endPhoneCallUsed
      ) {
        console.warn('[agent] blocked demo trade menu list');
        steerReply(
          'Do NOT list multiple trades in one sentence. ONE warm line — ask what business they have in mind, or suggest a single example like a quick electrician call.',
        );
      }

      if (
        testCall &&
        role === 'assistant' &&
        assistantOffersRedundantSampleCall(text) &&
        !flags.endPhoneCallUsed
      ) {
        console.warn('[agent] blocked redundant sample-call offer on demo line');
        steerReply(
          'They are ALREADY on the Hello Cara demo call — do NOT offer a sample call or ask if they want to hear how you sound. One warm line with personality: reflect what they said, then steer from their answer (product info or the trade they mentioned). No trade lists.',
        );
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
        hasCallerIdOnFile &&
        assistantAskedForCallerIdentity(text) &&
        !testCall &&
        !flags.endPhoneCallUsed &&
        !flags.callbackRequested &&
        !flags.actionTicketCreated
      ) {
        console.warn('[agent] blocked caller-identity ask — simple Q&A, caller ID on file', {
          display: callerLine.display,
        });
        void safeGenerateReply(
          'Do NOT ask for their name or phone number — they asked a simple store question, not a callback. Answer from your business instructions if you can. If you truly cannot answer, apologise once and ask what they need help with — still no name/number intake unless they explicitly want a message taken.',
        );
      }

      if (
        role === 'assistant' &&
        !flags.linkSent &&
        assistantClaimsLinkWasSent(text) &&
        !flags.endPhoneCallUsed
      ) {
        console.warn('[agent] blocked false link-sent claim');
        void safeGenerateReply(
          'Do NOT say the link was sent — the send tool has not succeeded yet. Apologise if needed and either call the send tool after consent or continue helping without claiming SMS delivery.',
        );
      }

      if (
        role === 'assistant' &&
        assistantSoundsLikeCorporateAssist(text) &&
        !flags.endPhoneCallUsed &&
        corporateAssistCorrectedEpoch !== replyTurnEpoch
      ) {
        corporateAssistCorrectedEpoch = replyTurnEpoch;
        console.warn('[agent] blocked corporate assist phrasing');
        steerReply(
          'Do NOT say "I\'m here to assist" or "What can I assist you with". Reply like a friendly Irish shop worker — e.g. "I\'m good thanks — yourself?" if they asked how you are, otherwise answer their question in one warm line.',
        );
      }

      if (
        role === 'assistant' &&
        !flags.endPhoneCallUsed &&
        !flags.awaitingAnythingElseReply &&
        assistantAskedAnythingElse(text) &&
        text.replace(/\?/g, '').trim().length > 80
      ) {
        diag.push('warn', 'premature_anything_else', { snippet: text.slice(0, 120) });
      }

      if (
        role === 'assistant' &&
        !flags.endPhoneCallUsed &&
        !flags.awaitingAnythingElseReply &&
        assistantTextSoundsLikeTerminalHangup(text) &&
        /\bthanks for (ringing|calling|trying)\b/i.test(text)
      ) {
        clearGoodbyeForceTimer();
        goodbyeForceTimer = setTimeout(() => {
          goodbyeForceTimer = null;
          if (session.userData.sessionFlags.endPhoneCallUsed) return;
          void (async () => {
            await waitForAgentSpeechPlayout(session, lastAssistantSpeechHandle);
            if (session.userData.sessionFlags.endPhoneCallUsed) return;
            await disconnectCallerLeg(session, session.userData, async () => {});
          })();
        }, 700);
      }

      if (role === 'assistant' && assistantTextSoundsLikeFakeHangup(text)) {
        clearFakeHangupGuardTimer();
        fakeHangupGuardTimer = setTimeout(() => {
          fakeHangupGuardTimer = null;
          if (session.userData.sessionFlags.endPhoneCallUsed) return;
          void disconnectCallerLeg(session, session.userData, () =>
            waitForAgentSpeechPlayout(session, lastAssistantSpeechHandle),
          );
        }, 500);
      }

      if (role === 'assistant') {
        if (lineMatchesGreeting(text, playbackGreetingText) && greetingTranscriptLogged) {
          return;
        }
        if (!allowBookingAutomation && lineMatchesGreeting(text, playbackGreetingText)) {
          return;
        }
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

        const pipelineSnapshot = diag.getPipeline();
        const orgSnapshot = {
          id: org.id,
          name: org.name,
          slug: org.slug,
          phoneNumber: org.phone_number,
          niche: org.niche,
        };
        const closeDiagnostics = buildCloseDiagnosticsPayload({
          latency: latencyTracker.snapshot(),
          ...(pipelineSnapshot ? { pipeline: pipelineSnapshot } : {}),
          sessionFlags: { ...ud.sessionFlags },
          events: diag.events(),
          greetingPlayed: greetingPlayedFlag,
          greetingSource,
          disclosureConfirmed,
          transcript: verbatim,
          identifiers: diag.getIdentifiers(),
          orgSnapshot,
          configSnapshot,
          greetingText: playbackGreetingText || null,
          isTestCall: testCall,
        });

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
          ...(testCall
            ? {
                is_test_call: true,
                test_profile_id: testProfile?.id ?? null,
                variant_label: testProfile?.name ?? null,
                diagnostics: closeDiagnostics,
              }
            : {}),
        };

        callLogId = await insertCallLog({
          organizationId: ud.organizationId,
          callerNumber: callerNumberRaw,
          durationSeconds,
          outcome,
          transcript: verbatim,
          calledNumber: persistCalledNumber || null,
          isTestCall: testCall,
          callSid: callSidAttr,
          roomName: roomName || null,
        });

        if (testCall && callLogId) {
          const reportSaved = await persistTestCallReportFromWorker({
            callLogId,
            organizationId: ud.organizationId,
            calledNumber: persistCalledNumber,
            callerNumber: callerNumberRaw,
            callSid: callSidAttr,
            roomName: roomName || null,
            durationSeconds,
            disclosureConfirmed,
            testProfileId: testProfile?.id ?? null,
            variantLabel: testProfile?.name ?? null,
            diagnostics: closeDiagnostics,
          });
          if (!reportSaved) {
            console.warn('[agent] test-call report direct persist failed', { callLogId });
          }
        }

        callLogWritten = true;
        console.info('[agent] call_log_persisted', {
          callLogId,
          outcome,
          transcriptLines: transcriptParts.length,
          testCall,
        });

        if (voiceWebhooksConfigured() && persistCalledNumber && callLogId) {
          void postCallComplete(initialPayload).then((webhookResult) => {
            if (!webhookResult.ok) {
              console.warn('[agent] call-complete webhook failed (call already in DB)', {
                error: webhookResult.error,
                callLogId,
              });
            }
          });
        } else if (voiceWebhooksConfigured() && persistCalledNumber && !callLogId) {
          console.error('[agent] call log insert failed — no row to sync dashboard', {
            durationSeconds,
            testCall,
          });
        }

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
          ttsModel: String(activeTtsModel),
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

        if (testCall && callLogId && voiceWebhooksConfigured() && persistCalledNumber) {
          const finalDiagnostics = buildCloseDiagnosticsPayload({
            latency: latencyTracker.snapshot(),
            ...(pipelineSnapshot ? { pipeline: pipelineSnapshot } : {}),
            sessionFlags: { ...ud.sessionFlags },
            events: diag.events(),
            greetingPlayed: greetingPlayedFlag,
            greetingSource,
            disclosureConfirmed,
            transcript: verbatim,
            identifiers: diag.getIdentifiers(),
            orgSnapshot,
            configSnapshot,
            costEstimate,
            postprocessRan: didPostprocess,
            knowledgeGapCount: knowledgeGaps.length,
            greetingText: playbackGreetingText || null,
            isTestCall: testCall,
          });
          const enrichResult = await postCallComplete({
            called_number: persistCalledNumber,
            call_sid: callSidAttr,
            room_name: roomName || null,
            caller_number: callerNumberRaw,
            duration_seconds: durationSeconds,
            outcome,
            transcript: verbatim,
            transcript_review: transcriptReview,
            ai_summary: aiSummary,
            disclosure_confirmed: disclosureConfirmed,
            is_test_call: true,
            test_profile_id: testProfile?.id ?? null,
            variant_label: testProfile?.name ?? null,
            diagnostics: finalDiagnostics,
          });
          if (!enrichResult.ok) {
            console.warn('[agent] test-call diagnostics enrichment webhook failed', {
              error: enrichResult.error,
              callLogId,
            });
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
          await finishUsageRecord({
            usageId: usageRecordId,
            durationSeconds,
            ...(testCall ? { syncSkipReason: 'test_call' } : {}),
          });
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
      /** Next session.say() TTS should be one Cartesia synthesis (greeting). */
      singleUtteranceTtsNext = false;

      override async ttsNode(
        text: ReadableStream<string>,
        modelSettings: Parameters<voice.Agent<CaraAgentUserData>['ttsNode']>[1],
      ) {
        const singleUtterance = this.singleUtteranceTtsNext;
        this.singleUtteranceTtsNext = false;
        return voice.Agent.default.ttsNode(
          this,
          buildTtsNodeInputStream(text, {
            provider: useCartesiaInference ? 'cartesia-inference' : 'elevenlabs',
            ttsModel: activeTtsModel,
            // Sentence-only buffering — comma early-flush caused staccato / letter-by-letter turbo TTS on demo line.
            earlyFlush: false,
            singleUtterance,
          }),
          modelSettings,
        );
      }
    }

    const agent = new CaraVoiceAgent({
      instructions: systemPrompt,
      tools: caraTools.toolContext({ vertical: orgVertical, demoLine: testCall }),
    });

    await session.start({ agent, room: ctx.room });
    resetDeadAirTimer();

    const aiDisclosure = resolveAiDisclosure({
      greetingText,
      niche: org.niche,
      businessType: org.agent_business_type,
      demoLine: testCall,
    });
    console.info('[ai-disclosure] resolved at boot', {
      disabled: aiDisclosure.disabled,
      source: aiDisclosure.source,
      textPreview: aiDisclosure.text ? `${aiDisclosure.text.slice(0, 36)}…` : '',
      textLength: aiDisclosure.text.length,
    });

    const speakOptionalAiDisclosure = () => {
      if (aiDisclosure.disabled || !aiDisclosure.text.trim()) return;
      sayPrepared(session, aiDisclosure.text, { allowInterruptions: true });
      session.userData.disclosureConfirmed = true;
    };

    const callerStillConnected = (): boolean => {
      try {
        return ctx.room.remoteParticipants.has(participant.identity);
      } catch {
        return false;
      }
    };

    if (playbackGreetingText) {
      if (testCall && DEMO_LINE_OPENING_PAUSE_MS > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, DEMO_LINE_OPENING_PAUSE_MS));
      }
      const greetingTtsModel =
        process.env.GREETING_TTS_MODEL?.trim() || activeTtsModel;
      const greetingUsesV3 = isElevenV3Model(greetingTtsModel);
      const GREETING_CACHE_WAIT_MS = greetingUsesV3 ? 500 : 450;
      void greetingCacheWarmPromise?.catch(() => undefined);

      const resolveGreetingPcm = async (): Promise<Buffer | null> => {
        if (!greetingCacheKey) return null;
        const cached = await loadCachedGreetingPcm(greetingCacheKey);
        if (cached?.byteLength) return cached;
        if (!greetingCacheWarmPromise) return null;
        try {
          await Promise.race([
            greetingCacheWarmPromise,
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('greeting_cache_wait_timeout')), GREETING_CACHE_WAIT_MS),
            ),
          ]);
        } catch {
          return null;
        }
        return loadCachedGreetingPcm(greetingCacheKey);
      };

      const playLiveTtsGreeting = async () => {
        if (greetingPlayoutComplete || greetingPlaybackStarted || !callerStillConnected()) return;
        greetingPlaybackStarted = true;
        try {
        agent.singleUtteranceTtsNext = true;
        const handle = sayPrepared(session, playbackGreetingText, {
          greeting: true,
          greetingCommaFlow: false,
          allowInterruptions: false,
        });
        greetingPlayedFlag = true;
        greetingSource = 'live_tts';
        latencyTracker.recordGreetingPlayback();
        console.info('[agent] greeting_playback', {
          source: 'live_tts',
          msSinceCallStart: Date.now() - callStartedAt,
        });
        diag.push('info', 'greeting_playback', {
          source: 'live_tts',
          msSinceCallStart: Date.now() - callStartedAt,
        });
        try {
          await waitForSpeechHandlePlayout(handle);
        } catch {
          /* playout wait best-effort */
        }
        greetingPlayoutComplete = true;
        speakOptionalAiDisclosure();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes('not running')) {
            console.error('[agent] live greeting play failed', e);
          }
        }
      };

      const cachedPcm = await resolveGreetingPcm();

      if (cachedPcm?.byteLength) {
        let fallbackUsed = false;
        try {
          if (!callerStillConnected()) {
            console.warn('[agent] greeting_skipped — caller disconnected before playback');
          } else {
          const sampleRate = pcmSampleRateFromEncoding(elevenEncoding);
          // PCM-only playback — never pass spoken text or TTS runs in parallel (echoey double audio).
          const handle = session.say('', {
            audio: pcmToAudioFrameStream(cachedPcm, sampleRate),
            addToChatCtx: false,
            allowInterruptions: false,
          });
          greetingAudioSpeechPending += 1;
          greetingPlaybackStarted = true;
          greetingPlayedFlag = true;
          greetingSource = 'cached_pcm';
          latencyTracker.recordGreetingPlayback();
          console.info('[agent] greeting_playback', {
            source: 'cached_pcm',
            msSinceCallStart: Date.now() - callStartedAt,
          });
          diag.push('info', 'greeting_playback', {
            source: 'cached_pcm',
            msSinceCallStart: Date.now() - callStartedAt,
          });

          const watchdog = setTimeout(() => {
            if (greetingPlayoutComplete || fallbackUsed) return;
            if (handle.done()) {
              greetingPlayoutComplete = true;
              return;
            }
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
            greetingPlayoutComplete = true;
            speakOptionalAiDisclosure();
          } catch (e) {
            console.error('[agent] cached greeting playout failed — live TTS fallback', e);
            if (!fallbackUsed && !greetingPlayoutComplete && session.agentState !== 'speaking') {
              fallbackUsed = true;
              await playLiveTtsGreeting();
            }
          } finally {
            clearTimeout(watchdog);
          }
          }
        } catch (e) {
          console.error('[agent] cached greeting play failed — live TTS fallback', e);
          if (callerStillConnected()) {
            await playLiveTtsGreeting();
          }
        }
      } else if (callerStillConnected()) {
        await playLiveTtsGreeting();
      }

      if (greetingIncludesAiDisclosure(greetingText) || aiDisclosure.disabled) {
        session.userData.disclosureConfirmed = true;
      }
    } else {
      allowBookingAutomation = true;
      const openInstructions = callPersona
        ? `The caller just connected. Open with ONE short greeting: "${callPersona.greeting}". Include the AI and call-recording notice exactly as specified in your instructions. Max 35 words.`
        : `The caller just connected. Speak first with ONE short greeting for ${org.name}. Max 35 words. Include the AI and call-recording notice exactly as specified in your instructions.`;
      await session.generateReply({ instructions: openInstructions });
      session.userData.disclosureConfirmed = true;
    }
  },
});

const _agentNameRaw = process.env.LIVEKIT_AGENT_NAME;
const resolvedAgentName =
  _agentNameRaw === undefined ? 'cliste-voice-node' : _agentNameRaw.trim();

void reapZombieUsageRows();

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    ...(resolvedAgentName ? { agentName: resolvedAgentName } : {}),
  }),
);
