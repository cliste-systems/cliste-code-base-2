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
import {
  countAssistantTranscriptChars,
  estimateCallCostUsd,
} from './lib/call_cost_estimate.js';
import { postprocessCallTranscript } from './lib/call_postprocess.js';
import { assessTranscriptCompleteness } from './lib/transcript_completeness.js';
import { insertCallLog, updateCallLogEnrichment, updateCallLogOutcome } from './lib/call_logs.js';
import { executePostCallActions, type PostCallAction } from './lib/post_call_actions.js';
import {
  formatRoutesForPrompt,
  routesForConversationalRetailPrompt,
} from './lib/routing_links.js';
import {
  buildCloseDiagnosticsPayload,
  createCallLatencyTracker,
} from './lib/call_close_diagnostics.js';
import { createCallDiagnosticSession } from './lib/call_diagnostic_bundle.js';
import {
  assistantTextSoundsLikeDemoFarewell,
  assistantTextSoundsLikeFakeHangup,
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
import {
  classifySttPipelineError,
  isSttRateLimitOrTransientError,
  resolveCallOutcomeWithSttFailure,
  STT_RECOVERY_SPEECH_LINE,
} from './lib/resilient_inference_stt.js';
import { prewarmInferenceStt } from './lib/stt_warmup.js';
import { resolveTtsConfig, CARTESIA_SIOBHAN_VOICE_ID, DEFAULT_ELEVEN_TTS_MODEL } from './lib/tts_config.js';
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
import { isFactoryFreshLine } from './lib/factory_fresh_line.js';
import {
  buildRetailConversationalOpening,
  isConversationalRetailLine,
  resolveConversationalRetailBusinessName,
  RETAIL_LINE_OPENING_PAUSE_MS,
  shouldUseDemoExperienceStack,
} from './lib/conversational_retail_line.js';
import { getActiveCallTestProfile } from './lib/test_profile.js';
import {
  detectDemoScenario,
  type DemoScenario,
} from './lib/demo_scenarios.js';
import {
  demoPlaybookBlockFromScenarios,
  loadDemoScenarios,
} from './lib/demo_scenarios_loader.js';
import { persistTestCallReportFromWorker } from './lib/persist_test_call_report.js';
import {
  drainReadableStream,
  emptyTextStream,
  settleInterruptedAgentSpeech,
  shouldArmDemoCloseFromCallerText,
  shouldDropLlmTtsWhileClosing,
} from './lib/demo_close.js';
import { buildDemoCallClosingLine, inferDemoCallerFirstName } from './lib/natural_phrasing.js';
import { buildDemoPersonaGreeting, DEMO_LINE_OPENING_PAUSE_MS, pickCallPersona, type CallPersona } from './lib/persona.js';
import { resolveSpokenBusinessName } from './lib/spoken_business_name.js';
import { orgVerticalLabel } from './lib/org_vertical.js';
import { sayPrepared } from './lib/say_prepared.js';
import {
  assistantAskedAnythingElse,
  assistantAwaitingCallerReply,
  assistantClaimsLinkWasSent,
  callerAskedNewQuestion,
  callerExplicitlyRequestedHangup,
  callerPivotedFromSmsConsent,
  callerSaidNothingElse,
  callerSoundsLikeAffirmativeConsent,
  callerWindingDownCall,
  callerSoundsLikeCallerFrustration,
  assistantSoundsLikeCorporateAssist,
} from './lib/speech_triggers.js';
import {
  detectLikelySttGarble,
  soundsLikeBookingIntent,
  soundsLikeCancelOrChangeAppointment,
} from './lib/stt_garble.js';
import { callerSoundsLikeRetailStaffQuestion } from './lib/retail_staff_questions.js';
import {
  buildRetailHoursSpokenReply,
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

/** Debug-mode runtime telemetry — also visible in Railway logs via console.info. */
function debugSessionLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
): void {
  const payload = {
    sessionId: '0f50f3',
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  console.info('[agent][debug]', payload);
  // #region agent log
  fetch('http://127.0.0.1:7662/ingest/95496c05-1739-4e32-b7be-319b56b1c5b5', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '0f50f3' },
    body: JSON.stringify(payload),
  }).catch(() => {});
  // #endregion
}

function tapLlmTextStreamForTranscript(
  source: ReadableStream<string>,
  onComplete: (spoken: string) => void,
): ReadableStream<string> {
  let buffer = '';
  return new ReadableStream<string>({
    start(controller) {
      const reader = source.getReader();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              buffer += value;
              controller.enqueue(value);
            }
          }
          controller.close();
          const spoken = buffer.trim();
          if (spoken.length > 3) onComplete(spoken);
        } catch (err) {
          controller.error(err);
        } finally {
          reader.releaseLock();
        }
      })();
    },
    cancel(reason) {
      return source.cancel(reason);
    },
  });
}

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
    try {
      await prewarmInferenceStt();
    } catch (e) {
      console.warn('[agent] stt_warmup_failed', e);
    }
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
    const factoryFreshLine =
      isFactoryFreshLine(calledNumber) ||
      isFactoryFreshLine(routing.phone) ||
      isFactoryFreshLine(org.phone_number);
    const testCall =
      !factoryFreshLine &&
      (isTestCall(calledNumber) ||
        isTestCall(routing.phone) ||
        isTestCall(org.phone_number));
    const conversationalRetailLine =
      !factoryFreshLine &&
      !testCall &&
      (isConversationalRetailLine(calledNumber) ||
        isConversationalRetailLine(routing.phone) ||
        isConversationalRetailLine(org.phone_number));
    /** 9508 = LiveKit turn loop only; no agent.ts guard rails. */
    const bareLiveKitRetailLane = conversationalRetailLine;
    const demoExperienceStack = shouldUseDemoExperienceStack({
      testCall,
      factoryFreshLine,
      conversationalRetailLine,
    });
    const testProfile =
      factoryFreshLine || !testCall ? null : await getActiveCallTestProfile();
    const demoScenarios: DemoScenario[] = testCall ? await loadDemoScenarios() : [];
    if (factoryFreshLine) {
      console.info('[agent] factory_fresh_line', {
        calledNumber: maskPhone(calledNumber),
        tts: 'cartesia/sonic-3.6:siobhan',
      });
    } else if (testCall) {
      console.info('[agent] test_call', {
        calledNumber: maskPhone(calledNumber),
        profile: testProfile?.name ?? '(none)',
      });
    } else if (conversationalRetailLine) {
      console.info('[agent] conversational_retail_line', {
        calledNumber: maskPhone(calledNumber),
        orgSlug: org.slug,
        bareLiveKitLane: bareLiveKitRetailLane,
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

    const ttsConfig = (() => {
      if (factoryFreshLine) {
        return {
          provider: 'cartesia-inference' as const,
          model: process.env.LIVEKIT_INFERENCE_TTS_MODEL?.trim() || 'cartesia/sonic-3.6',
          voiceId: process.env.LIVEKIT_INFERENCE_TTS_VOICE?.trim() || CARTESIA_SIOBHAN_VOICE_ID,
          language: process.env.LIVEKIT_INFERENCE_TTS_LANGUAGE?.trim() || 'en',
          label: `factory-fresh:${process.env.LIVEKIT_INFERENCE_TTS_MODEL?.trim() || 'cartesia/sonic-3.6'}:siobhan`,
        };
      }
      return resolveTtsConfig({
        testProfile,
        orgVoiceId: resolveOrgVoiceId(org),
      });
    })();
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
    const useDemoPersonaGreeting = testCall && !factoryFreshLine;
    const useConversationalOpening = useDemoPersonaGreeting || conversationalRetailLine;
    const playbackGreetingText = factoryFreshLine
      ? greetingText || "Hello, you're through to Cara."
      : useDemoPersonaGreeting && callPersona
        ? buildDemoPersonaGreeting(callPersona, personaSeed)
        : conversationalRetailLine
          ? buildRetailConversationalOpening(
              resolveConversationalRetailBusinessName({
                name: org.name,
                greeting: org.greeting,
              }),
            )
          : greetingText;
    const skipGreetingCache = useDemoPersonaGreeting && Boolean(playbackGreetingText);
    let greetingCacheWarmPromise: Promise<void> | null = null;
    if (
      conversationalRetailLine &&
      !useCartesiaInference &&
      playbackGreetingText &&
      !skipGreetingCache
    ) {
      const retailGreetingApiKey =
        process.env.ELEVEN_API_KEY?.trim() || process.env.ELEVENLABS_API_KEY?.trim() || '';
      if (retailGreetingApiKey) {
        greetingCacheWarmPromise = ensureGreetingPcmCached({
          orgId: org.id,
          greetingText: playbackGreetingText,
          apiKey: retailGreetingApiKey,
          voiceId: activeVoiceId,
          encoding: process.env.ELEVEN_TTS_ENCODING?.trim() || 'pcm_24000',
          baseURL:
            process.env.ELEVENLABS_BASE_URL?.trim() || 'https://api.elevenlabs.io/v1',
          voiceSettings: resolveElevenVoiceSettings(),
        })
          .then((pcm) => {
            console.info('[agent] greeting_pcm_warm', {
              orgId: org.id,
              bytes: pcm.byteLength,
              early: true,
            });
          })
          .catch((e) => {
            console.error('[agent] greeting pcm early warmup failed', e);
          });
      }
    }
    console.info('[agent] call_persona', {
      variant: callPersona.variant,
      demoLine: testCall,
      conversationalRetailLine,
      greetingPreview: playbackGreetingText.slice(0, 80),
      personaGreeting: useDemoPersonaGreeting,
    });

    const systemPrompt = buildCaraCallPrompt({
      businessName: conversationalRetailLine
        ? resolveConversationalRetailBusinessName({
            name: org.name,
            greeting: org.greeting,
          })
        : spokenBusinessName,
      customPrompt: custom,
      callerLine,
      routingLinks,
      bookingTimeZone: bookingTz,
      nowUtcIso,
      todayLocal,
      ttsModel: activeTtsModel,
      niche: org.niche,
      businessType: org.agent_business_type,
      openingGreetingDelivered: conversationalRetailLine
        ? true
        : useConversationalOpening
          ? false
          : Boolean(playbackGreetingText),
      structuredHoursBlock,
      demoMode: testCall && !factoryFreshLine,
      conversationalRetailMode: conversationalRetailLine,
      ...(callPersona && !conversationalRetailLine ? { persona: callPersona } : {}),
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
        demoScenarioSlug: null,
        demoScenarioBeat: 0,
        demoCallerReadyToClose: false,
        retailOpeningComplete: conversationalRetailLine,
        retailSubstantiveExchangeComplete: false,
        awaitingRetailCallerName: false,
        pendingCallbackSummary: null,
        retailCallerName: null,
      },
      disclosureConfirmed: conversationalRetailLine
        ? true
        : greetingIncludesAiDisclosure(greetingText),
      demoLine: testCall,
      conversationalRetailLine,
      factoryFreshLine,
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
      'assemblyai/universal-3-5-pro';
    const inferenceSttLanguage = process.env.LIVEKIT_INFERENCE_STT_LANGUAGE?.trim() || 'en';
    const inferenceLlmModel =
      testProfile?.llm_model?.trim() ||
      process.env.LIVEKIT_INFERENCE_LLM_MODEL?.trim() ||
      (demoExperienceStack ? 'openai/gpt-5.6-luna' : 'google/gemma-4-31b-it');
    const useBuilderDemoStack = demoExperienceStack;

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

    if (
      !greetingCacheWarmPromise &&
      !useCartesiaInference &&
      playbackGreetingText &&
      !skipGreetingCache &&
      elevenApiKey
    ) {
      greetingCacheWarmPromise = ensureGreetingPcmCached({
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
        });
    }

    const isU3RtProStt = isU3RtProSttModel(inferenceSttModel);
    // u3-rt-pro: LiveKit turn detector + tuned silence — STT-owned EOT interrupts TTS mid-reply.
    const useSttNeuralTurnDetection =
      !isU3RtProStt && process.env.LIVEKIT_STT_NEURAL_TURN?.trim() === '1';
    const latencyProfile = resolveSttLatencyProfile(
      useBuilderDemoStack
        ? process.env.LIVEKIT_TEST_STT_LATENCY_PROFILE?.trim() ||
            process.env.LIVEKIT_STT_LATENCY_PROFILE ||
            'snappy'
        : testCall
          ? process.env.LIVEKIT_TEST_STT_LATENCY_PROFILE?.trim() ||
              process.env.LIVEKIT_STT_LATENCY_PROFILE ||
              'snappy'
          : process.env.LIVEKIT_STT_LATENCY_PROFILE,
    );
    const silenceDefaults = assemblyAiTurnSilenceDefaults(inferenceSttModel, latencyProfile);
    const endpointDefaults = endpointingDefaults(latencyProfile, useSttNeuralTurnDetection);

    const endpointMinMs = Number.isFinite(
      Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MIN_MS ?? '', 10),
    )
      ? Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MIN_MS ?? '', 10)
      : useBuilderDemoStack
        ? 250
        : endpointDefaults.minDelayMs;
    const endpointMaxMs = Number.isFinite(
      Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MAX_MS ?? '', 10),
    )
      ? Number.parseInt(process.env.LIVEKIT_ENDPOINTING_MAX_MS ?? '', 10)
      : useBuilderDemoStack
        ? Number.parseInt(process.env.LIVEKIT_TEST_ENDPOINTING_MAX_MS ?? '2000', 10)
        : testCall
          ? Number.parseInt(process.env.LIVEKIT_TEST_ENDPOINTING_MAX_MS ?? '1200', 10)
          : endpointDefaults.maxDelayMs;
    const endpointMode = (process.env.LIVEKIT_ENDPOINTING_MODE?.trim() || 'dynamic') as
      | 'fixed'
      | 'dynamic';
    const useTurnDetector =
      !useSttNeuralTurnDetection &&
      (process.env.LIVEKIT_USE_TURN_DETECTOR?.trim().toLowerCase() || 'on') !== 'off';

    let turnDetectorInstance:
      | inference.TurnDetector
      | InstanceType<typeof lkTurn.turnDetector.EnglishModel>
      | null = null;
    if (useBuilderDemoStack) {
      try {
        turnDetectorInstance = new inference.TurnDetector();
      } catch (err) {
        console.error('[agent] audio turn-detector init failed — STT fallback', err);
      }
    } else if (useTurnDetector) {
      try {
        turnDetectorInstance = new lkTurn.turnDetector.EnglishModel();
      } catch (err) {
        console.error('[agent] turn-detector init failed — VAD/STT fallback', err);
      }
    }

    const interruptionMinMs = Number.parseInt(
      process.env.LIVEKIT_INTERRUPTION_MIN_MS ??
        (demoExperienceStack ? '450' : '200'),
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
    let sttMinTurnSilenceMs = Number.isFinite(
      Number.parseInt(process.env.LIVEKIT_STT_MIN_TURN_SILENCE_MS ?? '', 10),
    )
      ? Number.parseInt(process.env.LIVEKIT_STT_MIN_TURN_SILENCE_MS ?? '', 10)
      : silenceDefaults.minTurnSilenceMs;
    let sttMaxTurnSilenceMs = Number.isFinite(
      Number.parseInt(process.env.LIVEKIT_STT_MAX_TURN_SILENCE_MS ?? '', 10),
    )
      ? Number.parseInt(process.env.LIVEKIT_STT_MAX_TURN_SILENCE_MS ?? '', 10)
      : silenceDefaults.maxTurnSilenceMs;
    if (testCall && isU3RtProStt && !useBuilderDemoStack && !process.env.LIVEKIT_STT_MIN_TURN_SILENCE_MS?.trim()) {
      sttMinTurnSilenceMs = Number.parseInt(
        process.env.LIVEKIT_TEST_STT_MIN_TURN_SILENCE_MS ?? '400',
        10,
      );
    }
    if (testCall && isU3RtProStt && !useBuilderDemoStack && !process.env.LIVEKIT_STT_MAX_TURN_SILENCE_MS?.trim()) {
      sttMaxTurnSilenceMs = Number.parseInt(
        process.env.LIVEKIT_TEST_STT_MAX_TURN_SILENCE_MS ?? '1400',
        10,
      );
    }
    const sttEotConfidence = Number.isFinite(
      Number.parseFloat(process.env.LIVEKIT_STT_EOT_CONFIDENCE ?? ''),
    )
      ? Number.parseFloat(process.env.LIVEKIT_STT_EOT_CONFIDENCE ?? '')
      : silenceDefaults.eotConfidence;

    // 0.7 adds phrasing variety; still reliable for tool selection on gpt-4o-mini / gpt-5-mini.
    const llmTemperature = Number.parseFloat(process.env.LIVEKIT_LLM_TEMPERATURE ?? '0.7');
    const llmMaxCompletionTokens = testCall
      ? Number.parseInt(process.env.LIVEKIT_TEST_LLM_MAX_TOKENS ?? '320', 10)
      : Number.parseInt(process.env.LIVEKIT_LLM_MAX_TOKENS ?? '320', 10);

    const resolvedLlm = createCaraLlm({
      inferenceLlmModel,
      profileLlmProvider: testProfile?.llm_provider ?? null,
      forceGateway: useBuilderDemoStack,
      reasoningEffort: useBuilderDemoStack ? 'low' : undefined,
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

    const sessionStt = new inference.STT({
      model: inferenceSttModel,
      language: inferenceSttLanguage,
      modelOptions: sttModelOptions,
    });

    const pipelineLabel = {
      stt: inferenceSttModel,
      sttKeytermCount: sttKeyterms.length,
      sttNeuralTurn: useSttNeuralTurnDetection,
      latencyProfile,
      llm: resolvedLlm.label,
      tts: ttsConfig.label,
      voiceId: activeVoiceId,
      ttsProvider: ttsConfig.provider,
      endpointMinMs: endpointMinMs ?? null,
      endpointMaxMs: endpointMaxMs ?? null,
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
      stt: sessionStt,
      ...(useBuilderDemoStack ? {} : { vad: ctx.proc.userData.vad as silero.VAD }),
      llm: llmInstance,
      tts: sessionTts,
      userData: sessionUserData,
      maxToolSteps: 5,
      turnHandling: {
        preemptiveGeneration: {
          enabled: demoExperienceStack
            ? process.env.LIVEKIT_TEST_PREEMPTIVE_GENERATION?.trim() === '1'
            : process.env.LIVEKIT_PREEMPTIVE_GENERATION?.trim() === '1',
        },
        turnDetection: useBuilderDemoStack
          ? (turnDetectorInstance ?? undefined)
          : (turnDetectorInstance ?? 'stt'),
        endpointing: {
          ...(endpointMode ? { mode: endpointMode } : {}),
          ...(endpointMinMs !== undefined ? { minDelay: endpointMinMs } : {}),
          ...(endpointMaxMs !== undefined ? { maxDelay: endpointMaxMs } : {}),
        },
        interruption: {
          mode: interruptionMode,
          discardAudioIfUninterruptible: (() => {
            const raw = process.env.LIVEKIT_DISCARD_AUDIO_IF_UNINTERRUPTIBLE?.trim().toLowerCase();
            if (raw === 'true') return true;
            if (raw === 'false') return false;
            return demoExperienceStack;
          })(),
          minDuration: Number.isFinite(interruptionMinMs) ? interruptionMinMs : 200,
          minWords: Number.isFinite(interruptionMinWords) ? interruptionMinWords : 1,
        },
      },
    });

    const deadAirMs = demoExperienceStack
      ? Number.parseInt(process.env.DEMO_DEAD_AIR_MS ?? '20000', 10)
      : Number.parseInt(process.env.LIVEKIT_DEAD_AIR_MS ?? '10000', 10);
    const deadAirCloseMs = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_CLOSE_MS ?? '8000', 10);
    const deadAirMaxPrompts = Number.parseInt(process.env.LIVEKIT_DEAD_AIR_MAX_PROMPTS ?? '2', 10);
    const responseFillerMs = Number.parseInt(
      process.env.LIVEKIT_RESPONSE_FILLER_MS ?? (demoExperienceStack ? '1000' : '0'),
      10,
    );
    const responseFillerMaxPerCall = Number.parseInt(
      process.env.LIVEKIT_RESPONSE_FILLER_MAX_PER_CALL ?? '3',
      10,
    );
    const postGreetingGraceMs = conversationalRetailLine
      ? 0
      : demoExperienceStack
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
    let pendingLlmTtsTranscript = '';
    let lastAssistantSpokeAt = 0;
    let corporateAssistCorrectedEpoch = -1;
    let programmaticSpeechPending = 0;
    let lastCallerUtterance = '';
    let llmReplySpeechQueued = false;
    let thinkingStartedAt: number | null = null;
    let userStoppedSpeakingAt: number | null = null;
    let sttFailureDetected = false;
    let ttsFailureDetected = false;
    let sttRecoverySpeechPlayed = false;

    const transcriptParts: TranscriptLine[] = [];
    let transcriptSeq = 0;
    const recentCallerTranscripts = new Map<string, number>();
    const recentAssistantTranscripts = new Map<string, number>();

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

    const isDuplicateAssistantUtterance = (key: string, at: number): boolean => {
      const prev = recentAssistantTranscripts.get(key);
      if (prev !== undefined && at - prev < CALLER_TRANSCRIPT_DEDUPE_MS) {
        return true;
      }
      recentAssistantTranscripts.set(key, at);
      return false;
    };

    const getLatestAssistantChatText = (): string => {
      try {
        const items = session.history.items;
        for (let i = items.length - 1; i >= 0; i -= 1) {
          const chatItem = items[i];
          if (chatItem.type !== 'message' || chatItem.role !== 'assistant') continue;
          const text =
            chatItem.textContent?.trim() ||
            ('rawTextContent' in chatItem
              ? (chatItem as { rawTextContent?: string }).rawTextContent?.trim()
              : undefined);
          if (text && text.length > 3) return text;
        }
      } catch {
        /* ignore */
      }
      return '';
    };

    const syncAssistantTranscriptFromHistory = (at: number): number => {
      const logged = new Set(
        transcriptParts
          .filter((part) => part.line.startsWith('Assistant:'))
          .map((part) => normalizeTranscriptKey(part.line.slice('Assistant: '.length))),
      );
      let appended = 0;
      for (const chatItem of session.history.items) {
        if (chatItem.type !== 'message' || chatItem.role !== 'assistant') continue;
        const text =
          chatItem.textContent?.trim() ||
          ('rawTextContent' in chatItem
            ? (chatItem as { rawTextContent?: string }).rawTextContent?.trim()
            : undefined);
        if (!text || text.length <= 3) continue;
        const key = normalizeTranscriptKey(text);
        if (logged.has(key)) continue;
        if (appendAssistantTranscriptLine(text, at, chatItem.interrupted)) {
          logged.add(key);
          appended += 1;
        }
      }
      return appended;
    };

    const appendAssistantTranscriptLine = (
      text: string,
      at: number,
      interrupted = false,
    ): boolean => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      if (lineMatchesGreeting(trimmed, playbackGreetingText) && greetingTranscriptLogged) {
        return false;
      }
      const key = normalizeTranscriptKey(trimmed);
      if (isDuplicateAssistantUtterance(key, at)) return false;
      const note = interrupted ? ' [cut off]' : '';
      appendTranscriptLine(at, `Assistant: ${trimmed}${note}`);
      debugSessionLog('E', 'agent.ts:appendAssistantTranscriptLine', 'assistant_transcript_appended', {
        textLen: trimmed.length,
        interrupted,
      });
      return true;
    };

    const flushPendingAssistantTranscript = (at: number, interrupted = false): boolean => {
      const pending = lastAssistantChatText.trim();
      if (pending) {
        const appended = appendAssistantTranscriptLine(pending, at, interrupted);
        if (appended) lastAssistantChatText = '';
        return appended;
      }
      const fromHistory = getLatestAssistantChatText();
      if (!fromHistory) return false;
      return appendAssistantTranscriptLine(fromHistory, at, interrupted);
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
      if (bareLiveKitRetailLane || isCallEnding()) return;
      clearCallerReplyNudgeTimer();
      cancelInFlightReply();
      safeGenerateReply(instructions, { force: true });
    };

    const safeGenerateReply = (
      instructions: string,
      opts?: { force?: boolean },
    ) => {
      if (isCallEnding()) return;
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
      if (!demoExperienceStack && inListenGrace()) return false;
      return true;
    };

    const retryFailedReplyOnce = (source: string) => {
      if (bareLiveKitRetailLane || replyRetryUsedForTurn || isCallEnding()) return;
      if (testCall) return;
      if (!canPlayRecoverySpeech()) return;
      if (session.userState === 'speaking') return;
      replyRetryUsedForTurn = true;
      console.warn('[agent] reply_retry', { source, epoch: replyTurnEpoch });
      safeGenerateReply(REPLY_RETRY_INSTRUCTIONS, { force: true });
    };

    const playPipelineRecoverySpeech = (reason: string, stage: 'stt' | 'tts') => {
      if (bareLiveKitRetailLane || sttRecoverySpeechPlayed || isCallEnding()) return;
      if (testCall) return;
      sttRecoverySpeechPlayed = true;
      console.warn('[agent] pipeline_recovery_speech', { reason, stage });
      diag.push('warn', 'pipeline_recovery_speech', { reason, stage });
      try {
        sayPrepared(session, STT_RECOVERY_SPEECH_LINE, {
          allowInterruptions: true,
          addToChatCtx: true,
        });
      } catch (e) {
        console.error('[agent] pipeline_recovery_speech_failed', e);
      }
    };

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const err = ev.error;
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : typeof err === 'object' && err !== null
              ? JSON.stringify(err)
              : String(err);
      console.error('[AgentSession] pipeline error', msg, err);
      const stage = classifyPipelineErrorStage(msg);
      diag.push('error', `pipeline_${stage}_error`, { message: msg, stage });
      if (stage === 'stt') {
        sttFailureDetected = true;
        const sttMeta = classifySttPipelineError(msg, err);
        if (sttMeta.retryable || isSttRateLimitOrTransientError(msg, err)) {
          console.warn('[agent] stt_rate_limit_or_transient', sttMeta);
          diag.push('warn', 'stt_rate_limit_or_transient', sttMeta);
        }
        playPipelineRecoverySpeech('pipeline_stt_error', 'stt');
      }
      if (stage === 'tts') {
        ttsFailureDetected = true;
        if (isSttRateLimitOrTransientError(msg, err)) {
          console.warn('[agent] tts_rate_limit_or_transient', { message: msg.slice(0, 120) });
          diag.push('warn', 'tts_rate_limit_or_transient', { message: msg.slice(0, 120) });
        }
        playPipelineRecoverySpeech('pipeline_tts_error', 'tts');
      }
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
          retryable:
            stage === 'stt'
              ? classifySttPipelineError(msg, err).retryable
              : true,
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
      if (bareLiveKitRetailLane) return;
      clearCallerReplyNudgeTimer();
      if (testCall || !allowBookingAutomation || isCallEnding()) return;
      if (conversationalRetailLine && !session.userData.sessionFlags.retailOpeningComplete) return;
      const epoch = replyTurnEpoch;
      const utterance = lastCallerUtterance.trim();
      if (!utterance) return;
      callerReplyNudgeTimer = setTimeout(() => {
        callerReplyNudgeTimer = null;
        if (epoch !== replyTurnEpoch || isCallEnding()) return;
        if (session.agentState !== 'listening' || session.userState === 'speaking') return;
        if (generateReplyInFlight) return;
        console.warn('[agent] caller_reply_nudge', { utterance: utterance.slice(0, 80) });
        safeGenerateReply(
          `The caller said: "${utterance.slice(0, 200)}". Reply in **one short spoken sentence** (~25 words max). ` +
            'Do not repeat your opening greeting or any AI/recording disclosure. ' +
            'Do not say "grand". If they asked whether you can hear them, say yes warmly and ask how you can help.',
          { force: true },
        );
      }, CALLER_REPLY_NUDGE_MS);
    };

    const clearGreetingInterruptFallbackTimer = () => {
      if (greetingInterruptFallbackTimer) {
        clearTimeout(greetingInterruptFallbackTimer);
        greetingInterruptFallbackTimer = null;
      }
    };

    const scheduleGreetingInterruptFallback = () => {
      if (bareLiveKitRetailLane) return;
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
      if (reason === 'greeting_interrupted' && !conversationalRetailLine) {
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

    let demoCloseOutroQueued = false;

    const maybeCloseDemoCall = () => {
      const flags = session.userData.sessionFlags;
      if (!testCall || !flags.demoCallerReadyToClose) return;
      if (flags.endPhoneCallUsed || demoCloseOutroQueued) return;

      demoCloseOutroQueued = true;
      flags.closingCall = true;
      clearAllGuardTimers();
      bumpReplyTurn('demo_programmatic_close');
      cancelInFlightReply();
      void (async () => {
        try {
          await settleInterruptedAgentSpeech(session, {
            isGenerateReplyInFlight: () => generateReplyInFlight,
            lastHandle: lastAssistantSpeechHandle,
          });
          const callerLines = transcriptParts
            .filter((part) => part.line.startsWith('Caller:'))
            .map((part) => part.line.slice('Caller: '.length));
          const handle = sayPrepared(
            session,
            buildDemoCallClosingLine(
              callSidAttr,
              inferDemoCallerFirstName(callerLines),
              localHour,
            ),
            {
              allowInterruptions: false,
            },
          );
          await waitForSpeechHandlePlayout(handle);
          await disconnectCallerLeg(session, session.userData, async () => {});
        } catch (e) {
          console.error('[AgentSession] auto close demo call failed', e);
        }
      })();
    };

    const armDemoCloseFromCallerText = (
      text: string,
      source: 'stt_final' | 'stt_interim' | 'conversation_item',
    ): boolean => {
      if (!testCall || session.userData.sessionFlags.endPhoneCallUsed) return false;
      const flags = session.userData.sessionFlags;
      const interim = source === 'stt_interim';
      if (!shouldArmDemoCloseFromCallerText(text, flags, { interim })) {
        return false;
      }
      if (!flags.demoCallerReadyToClose) {
        flags.demoCallerReadyToClose = true;
        if (source.startsWith('stt_')) {
          console.info('[agent] demo_close_armed_early', {
            source,
            snippet: text.slice(0, 120),
          });
          diag.push('info', 'demo_close_armed_early', {
            source,
            snippet: text.slice(0, 120),
          });
        }
      }
      flags.closingCall = true;
      cancelInFlightReply();
      maybeCloseDemoCall();
      return true;
    };

    const maybeSayRetailProgrammaticReply = (line: string) => {
      clearCallerReplyNudgeTimer();
      cancelInFlightReply();
      bumpReplyTurn('retail_programmatic');
      sayPrepared(session, line, { allowInterruptions: true });
    };

    const tryRetailProgrammaticHoursReply = (
      questionText: string,
      opts?: { correcting?: boolean; apologise?: boolean },
    ): boolean => {
      if (session.userData.sessionFlags.endPhoneCallUsed) return false;
      const reply = buildRetailHoursSpokenReply(org.business_hours, questionText, bookingTz, {
        correcting: opts?.correcting,
      });
      if (!reply) return false;
      let line = reply;
      if (opts?.apologise && !opts?.correcting) {
        line = `Sorry about that — ${reply.charAt(0).toLowerCase()}${reply.slice(1)}`;
      }
      maybeSayRetailProgrammaticReply(line);
      return true;
    };

    const ingestCallerFinalText = (
      text: string,
      bumpReason: string,
      at: number,
    ): boolean => {
      const trimmed = text.trim();
      const priorCallerUtterance = lastCallerUtterance;
      lastCallerUtterance = trimmed;
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
      if (testCall && armDemoCloseFromCallerText(text, 'conversation_item')) {
        return true;
      }
      let handledWithProgrammaticReply = false;
      if (
        !conversationalRetailLine &&
        org.niche === 'retail' &&
        callerSoundsLikeCallerFrustration(trimmed) &&
        priorCallerUtterance &&
        !session.userData.sessionFlags.endPhoneCallUsed
      ) {
        if (tryRetailProgrammaticHoursReply(priorCallerUtterance, { apologise: true })) {
          handledWithProgrammaticReply = true;
        } else {
          steerReply(
            `The caller said: "${trimmed.slice(0, 120)}". Apologise briefly for the pause, then answer what they asked about: "${priorCallerUtterance.slice(0, 120)}" in one short sentence. Do not ask anything else first.`,
          );
        }
      } else if (
        !conversationalRetailLine &&
        org.niche === 'retail' &&
        !session.userData.sessionFlags.endPhoneCallUsed
      ) {
        const correcting = callerSoundsLikeWeekdayHoursCorrection(trimmed);
        if (
          (callerSoundsLikeOpenHoursQuestion(trimmed) || correcting) &&
          tryRetailProgrammaticHoursReply(trimmed, { correcting })
        ) {
          handledWithProgrammaticReply = true;
        } else if (callerSoundsLikeRetailStaffQuestion(trimmed)) {
          steerReply(
            'The caller is asking about a store or department manager (their speech may be garbled). Answer from your business instructions — store manager, fresh food manager, ambient manager. This is a simple info question: do NOT ask for their name or phone number and do NOT offer to take a message unless they explicitly want a callback.',
          );
        }
      } else if (
        !testCall &&
        !bareLiveKitRetailLane &&
        session.userData.sessionFlags.likelySttGarble &&
        soundsLikeBookingIntent(text) &&
        allowBookingAutomation
      ) {
        void safeGenerateReply(
          'That last utterance may be STT garble — do not treat it as a confirmed booking request. Ask one short clarifying question about what they need.',
        );
      }
      if (callerPivotedFromSmsConsent(text, { awaitingSmsConsent: session.userData.sessionFlags.bookingLinkSendInFlight })) {
        session.userData.sessionFlags.bookingRouteId = null;
        diag.push('warn', 'booking_consent_pivot', { snippet: text.slice(0, 120) });
        if (!conversationalRetailLine) {
          steerReply(
            'The caller pivoted away from SMS consent — stop treating their last line as yes/no to texting. Answer their new question or offer a callback.',
          );
        }
      }
      if (!testCall && !conversationalRetailLine) {
        maybeCloseAfterAnythingElse(text);
      }
      if (!testCall && !handledWithProgrammaticReply) {
        scheduleCallerReplyNudge();
      }
      return true;
    };

    const resetClosePhaseIfCallerContinues = (text: string) => {
      const flags = session.userData.sessionFlags;
      if (flags.demoCallerReadyToClose && (callerAskedNewQuestion(text) || text.trim().length > 14)) {
        if (!callerWindingDownCall(text) && !callerExplicitlyRequestedHangup(text)) {
          flags.demoCallerReadyToClose = false;
        }
      }
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

    let warmCloseStarted = false;

    const performWarmProgrammaticClose = () => {
      const flags = session.userData.sessionFlags;
      if (flags.endPhoneCallUsed || warmCloseStarted) return;
      warmCloseStarted = true;
      flags.closingCall = true;
      clearAllGuardTimers();
      try {
        session.interrupt();
      } catch {
        /* ignore */
      }
      void (async () => {
        try {
          const closingLine = buildWarmCallClosingLine(
            {
              name: org.name,
              greeting: org.greeting,
              preserveRetailLocation: conversationalRetailLine,
            },
            callSidAttr ?? undefined,
          );
          const handle = sayPrepared(session, closingLine, {
            allowInterruptions: false,
          });
          await waitForSpeechHandlePlayout(handle);
          await disconnectCallerLeg(session, session.userData, async () => {});
        } catch (e) {
          console.error('[AgentSession] warm programmatic close failed', e);
        }
      })();
    };

    const maybeCloseAfterAnythingElse = (text: string) => {
      const flags = session.userData.sessionFlags;
      if (testCall || conversationalRetailLine || !flags.askedAnythingElse || !callerWindingDownCall(text)) return;
      if (flags.bookingLinkSendInFlight) return;
      if (flags.endPhoneCallUsed) return;

      flags.callerRespondedAfterAnythingElse = true;
      performWarmProgrammaticClose();
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
    const armDemoFarewellForceHangup = (text: string) => {
      const flags = session.userData.sessionFlags;
      if (
        !testCall ||
        flags.endPhoneCallUsed ||
        flags.awaitingAnythingElseReply ||
        !assistantTextSoundsLikeDemoFarewell(text)
      ) {
        return;
      }
      clearGoodbyeForceTimer();
      diag.push('info', 'demo_farewell_force_hangup', { snippet: text.slice(0, 120) });
      goodbyeForceTimer = setTimeout(() => {
        goodbyeForceTimer = null;
        if (session.userData.sessionFlags.endPhoneCallUsed) return;
        void (async () => {
          await waitForAgentSpeechPlayout(session, lastAssistantSpeechHandle);
          if (session.userData.sessionFlags.endPhoneCallUsed) return;
          await disconnectCallerLeg(session, session.userData, async () => {});
        })();
      }, 700);
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
    };

    const resetDeadAirTimer = () => {
      if (bareLiveKitRetailLane) return;
      clearDeadAirTimers();
      if (isCallEnding()) return;
      const f = session.userData.sessionFlags;
      if (f.askedAnythingElse && f.callerRespondedAfterAnythingElse) return;
      if (f.bookingLinkSendInFlight) return;
      if (callerAwaitingReply) return;
      if (inListenGrace() && !demoExperienceStack) return;
      deadAirTimer = setTimeout(() => {
        deadAirTimer = null;
        try {
          if (isCallEnding()) return;
          if (callerAwaitingReply) return;
          if (inListenGrace() && !demoExperienceStack) return;
          if (session.agentState !== 'listening' || session.userState === 'speaking') return;
          if (deadAirPromptCount >= deadAirMaxPrompts) {
            if (session.agentState === 'speaking' || session.agentState === 'thinking') return;
            if (callerAwaitingReply) return;
            gracefulDisconnect();
            return;
          }
          deadAirPromptCount += 1;
          sayProgrammatic('Sorry — are you still there?');
          deadAirCloseTimer = setTimeout(() => {
            deadAirCloseTimer = null;
            try {
              if (isCallEnding()) return;
              if (callerAwaitingReply) return;
              if (session.agentState === 'speaking' || session.agentState === 'thinking') return;
              if (session.userState === 'speaking') return;
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

    if (testCall) {
      session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
        const text = ev.transcript?.trim();
        if (!text || session.userData.sessionFlags.endPhoneCallUsed) return;
        const source = ev.isFinal ? 'stt_final' : 'stt_interim';
        armDemoCloseFromCallerText(text, source);
      });
    }

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
      } else if (ev.newState === 'listening') {
        clearResponseFillerTimer();
        clearCallerReplyNudgeTimer();
        if (ev.oldState === 'speaking' && allowBookingAutomation) {
          flushPendingAssistantTranscript(Date.now());
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
          if (pendingLlmTtsTranscript.trim()) {
            appendAssistantTranscriptLine(pendingLlmTtsTranscript.trim(), Date.now());
            pendingLlmTtsTranscript = '';
            debugSessionLog('B', 'agent.ts:SpeechCreated', 'transcript_from_tts_tap', {
              source: 'pendingLlmTtsTranscript',
            });
            return;
          }
          // SpeechHandle text/source can be empty even when TTS played; chat ctx has the line.
          if (lastAssistantChatText.trim()) {
            appendAssistantTranscriptLine(lastAssistantChatText.trim(), Date.now());
            lastAssistantChatText = '';
            return;
          }
          if (flushPendingAssistantTranscript(Date.now())) {
            debugSessionLog('C', 'agent.ts:SpeechCreated', 'transcript_flushed', {
              source: 'flushPendingAssistantTranscript',
            });
            return;
          }
          if (lastAssistantSpokeAt > 0 && Date.now() - lastAssistantSpokeAt < 8000) {
            debugSessionLog('D', 'agent.ts:SpeechCreated', 'empty_speech_suppressed_recent_speak', {
              msSinceSpeak: Date.now() - lastAssistantSpokeAt,
              pendingTtsLen: pendingLlmTtsTranscript.length,
              historyAssistantLen: getLatestAssistantChatText().length,
            });
            return;
          }
          debugSessionLog('A', 'agent.ts:SpeechCreated', 'empty_speech_handle', {
            pendingTtsLen: pendingLlmTtsTranscript.length,
            lastAssistantLen: lastAssistantChatText.length,
            historyAssistantLen: getLatestAssistantChatText().length,
            historyAssistantCount: session.history.items.filter(
              (i) => i.type === 'message' && i.role === 'assistant',
            ).length,
          });
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
      const rawAssistantText =
        role === 'assistant' && 'rawTextContent' in item
          ? (item as { rawTextContent?: string }).rawTextContent?.trim()
          : undefined;
      const text = (item.textContent?.trim() || rawAssistantText || '').trim();
      if (!text) {
        if (role === 'assistant') {
          debugSessionLog('A', 'agent.ts:ConversationItemAdded', 'assistant_item_empty_text', {
            hasTextContent: Boolean(item.textContent?.trim()),
            rawLen: rawAssistantText?.length ?? 0,
          });
        }
        return;
      }

      if (role === 'user') {
        ingestCallerFinalText(text, 'caller_conversation_item', ev.createdAt);
      }

      if (isCallEnding()) {
        if (role === 'assistant') {
          armDemoFarewellForceHangup(text);
        }
        const label = role === 'user' ? 'Caller' : 'Assistant';
        const interruptedNote =
          item.interrupted && (role === 'assistant' || role === 'user') ? ' [cut off]' : '';
        appendTranscriptLine(ev.createdAt, `${label}: ${text}${interruptedNote}`);
        return;
      }

      const flags = session.userData.sessionFlags;
      if (role === 'assistant' && text.length > 3 && !assistantTextSoundsLikeFakeHangup(text)) {
        if (
          conversationalRetailLine &&
          !lineMatchesGreeting(text, playbackGreetingText)
        ) {
          flags.retailSubstantiveExchangeComplete = true;
        }
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
        debugSessionLog('F', 'agent.ts:ConversationItemAdded', 'anything_else_asked', {
          count: flags.anythingElseAskCount,
          snippet: text.slice(0, 80),
        });
      }
      if (
        role === 'assistant' &&
        hasCallerIdOnFile &&
        assistantAskedForPhoneNumber(text) &&
        !flags.endPhoneCallUsed
      ) {
        if (!conversationalRetailLine) {
          console.warn('[agent] blocked phone-number ask — caller ID on file', {
            display: callerLine.display,
          });
          void safeGenerateReply(
            `You must NOT ask for their phone number — caller ID is already on file (${callerLine.display}). Apologise in one short sentence, then continue helping. For messages or cancellations use takeCallbackMessage with name and staffSummary only — omit callbackPhone.`,
          );
        }
      }

      if (
        role === 'assistant' &&
        hasCallerIdOnFile &&
        assistantAskedForCallerIdentity(text) &&
        !testCall &&
        !conversationalRetailLine &&
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
        !flags.endPhoneCallUsed &&
        !bareLiveKitRetailLane
      ) {
        console.warn('[agent] blocked false link-sent claim');
        void safeGenerateReply(
          'Do NOT say the link was sent — the send tool has not succeeded yet. Apologise if needed and either call the send tool after consent or continue helping without claiming SMS delivery.',
        );
      }

      if (
        !testCall &&
        !conversationalRetailLine &&
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
        testCall &&
        role === 'assistant' &&
        !flags.endPhoneCallUsed &&
        !flags.awaitingAnythingElseReply
      ) {
        armDemoFarewellForceHangup(text);
      }

      if (
        !testCall &&
        !conversationalRetailLine &&
        role === 'assistant' &&
        !flags.endPhoneCallUsed &&
        (!flags.awaitingAnythingElseReply || flags.callerRespondedAfterAnythingElse) &&
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

      if (!testCall && !conversationalRetailLine && role === 'assistant' && assistantTextSoundsLikeFakeHangup(text)) {
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
        appendAssistantTranscriptLine(text, ev.createdAt, item.interrupted);
      }
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      resetDeadAirTimer();
      for (const [call, out] of voice.zipFunctionCallsAndOutputs(ev)) {
        if (call.name === 'endPhoneCall') {
          session.userData.sessionFlags.closingCall = true;
          clearAllGuardTimers();
          debugSessionLog('G', 'agent.ts:FunctionToolsExecuted', 'endPhoneCall_invoked', {
            conversationalRetailLine,
          });
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
    let callFinalizePromise: Promise<void> | null = null;
    ctx.addShutdownCallback(async () => {
      if (callFinalizePromise) {
        await callFinalizePromise;
      }
    });

    session.on(voice.AgentSessionEventTypes.Close, () => {
      if (callLogWritten) return;
      clearAllGuardTimers();

      const mirrorBase = () => ({
        callerNumber: callerNumberRaw,
        startedAtMs: callStartedAt,
        jobId: livekitJobId,
        orgName: org.name,
      });

      const udSnapshot = session.userData;
      callFinalizePromise = (async () => {
      let durationSeconds = 0;
      let outcome = 'answered';
      let verbatim: string | null = null;
      let callLogId: string | null = null;
      let aiSummary: string | null = null;

      try {
        const ud = udSnapshot;
        if (!ud?.organizationId) {
          console.error('[agent] call log skipped — missing organizationId on close');
          return;
        }
        console.info('[agent] call_close_finalize_start', {
          organizationId: ud.organizationId,
          transcriptLines: transcriptParts.length,
        });

        const transcriptFlushMs = Number.parseInt(
          process.env.LIVEKIT_TRANSCRIPT_FLUSH_MS ?? '300',
          10,
        );
        await waitForSessionPlayout(session);
        if (Number.isFinite(transcriptFlushMs) && transcriptFlushMs > 0) {
          await new Promise((r) => setTimeout(r, Math.min(transcriptFlushMs, 2000)));
        }
        flushPendingAssistantTranscript(Date.now());
        const syncedFromHistory = syncAssistantTranscriptFromHistory(Date.now());
        if (syncedFromHistory > 0) {
          debugSessionLog('C', 'agent.ts:call_close', 'history_sync_appended', {
            count: syncedFromHistory,
          });
        }

        durationSeconds = Math.max(0, Math.round((Date.now() - callStartedAt) / 1000));
        outcome = canonicalCallOutcome({
          linkSent: ud.sessionFlags.linkSent,
          actionTicketCreated: ud.sessionFlags.actionTicketCreated,
          callbackRequested: ud.sessionFlags.callbackRequested,
          endPhoneCallUsed: ud.sessionFlags.endPhoneCallUsed,
        });
        const sttFailureOverride = resolveCallOutcomeWithSttFailure({
          transcriptLineCount: transcriptParts.length,
          sttFailureDetected: sttFailureDetected || ttsFailureDetected,
        });
        if (sttFailureOverride) {
          outcome = sttFailureOverride.outcome;
          aiSummary = sttFailureOverride.aiSummary;
        }

        const verbatimRaw = mergeTranscriptLines(transcriptParts);
        verbatim = verbatimRaw ? redactPii(verbatimRaw) : null;

        const transcriptCompleteness = assessTranscriptCompleteness(verbatim);
        if (
          transcriptCompleteness.callerLineCount > 1 &&
          transcriptCompleteness.assistantLineCount <= 1
        ) {
          console.warn('[agent] transcript_capture_incomplete', transcriptCompleteness);
          diag.push('warn', 'transcript_capture_incomplete', transcriptCompleteness);
          debugSessionLog('E', 'agent.ts:call_close', 'transcript_capture_incomplete', {
            ...transcriptCompleteness,
            transcriptLineCount: transcriptParts.length,
          });
        }

        mirrorLatestCall({
          ...mirrorBase(),
          callLogId: null,
          durationSeconds,
          outcome,
          transcript: verbatim,
          aiSummary,
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
          ai_summary: aiSummary,
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
        let postCallActions: PostCallAction[] = [];
        let knowledgeGaps: Array<{
          topic: string;
          caller_context?: string;
          cara_question?: string;
          suggested_section?: string;
        }> = [];
        const presetAiSummary = aiSummary;
        const retailRoutesCatalog = conversationalRetailLine
          ? formatRoutesForPrompt(routesForConversationalRetailPrompt(routingLinks))
          : undefined;
        if (verbatim) {
          const pp = await postprocessCallTranscript({
            verbatim,
            businessName: org.name,
            outcome,
            inferenceLlmModel,
            actionTicketCreated: ud.sessionFlags.actionTicketCreated,
            businessHours: org.business_hours,
            conversationalRetailLine,
            routesCatalog: retailRoutesCatalog,
          });
          transcriptReview = pp.transcriptReview ? redactPii(pp.transcriptReview) : null;
          aiSummary = pp.aiSummary ? redactPii(pp.aiSummary) : presetAiSummary;
          knowledgeGaps = pp.knowledgeGaps;
          postCallActions = pp.postCallActions;
          didPostprocess = true;
        }

        if (
          conversationalRetailLine &&
          postCallActions.length > 0 &&
          persistCalledNumber
        ) {
          const exec = await executePostCallActions({
            organizationId: ud.organizationId,
            calledNumber: persistCalledNumber,
            callerNumber: callerNumberRaw,
            actions: postCallActions,
          });
          if (exec.actionTicketCreated) {
            ud.sessionFlags.actionTicketCreated = true;
            outcome = 'action_created';
            knowledgeGaps = [];
            if (callLogId) {
              const patched = await updateCallLogOutcome(callLogId, outcome);
              if (!patched) {
                console.error('[agent] call log outcome patch failed', callLogId);
              }
            }
            console.info('[agent] post_call_actions_executed', {
              callLogId,
              executed: exec.executed.length,
              errors: exec.errors.length,
            });
          } else if (exec.errors.length > 0) {
            console.error('[agent] post_call_actions_failed', {
              callLogId,
              errors: exec.errors,
            });
          }
        }

        const costEstimate = estimateCallCostUsd({
          durationSeconds,
          smsSegmentsSent: ud.sessionFlags.smsSent,
          didPostprocess,
          transcriptChars: verbatim?.length ?? 0,
          assistantTranscriptChars: verbatim ? countAssistantTranscriptChars(verbatim) : 0,
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

        if (
          conversationalRetailLine &&
          callLogId &&
          voiceWebhooksConfigured() &&
          persistCalledNumber &&
          (postCallActions.length > 0 || transcriptReview || aiSummary)
        ) {
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
            post_call_actions: postCallActions.map((action) =>
              action.type === 'action_ticket'
                ? {
                    type: action.type,
                    callerName: action.callerName,
                    summary: action.summary,
                    routeId: action.routeId,
                  }
                : {
                    type: action.type,
                    callerName: action.callerName,
                    reason: action.reason,
                  },
            ),
          });
          if (!enrichResult.ok) {
            console.warn('[agent] post_call_actions enrichment webhook failed', {
              error: enrichResult.error,
              callLogId,
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
      })();
    });

    class CaraVoiceAgent extends voice.Agent<CaraAgentUserData> {
      /** Next session.say() TTS should be one Cartesia synthesis (greeting). */
      singleUtteranceTtsNext = false;

      override async ttsNode(
        text: ReadableStream<string>,
        modelSettings: Parameters<voice.Agent<CaraAgentUserData>['ttsNode']>[1],
      ) {
        const preparedSpeechNext =
          this.session.userData.preparedSpeechSingleUtteranceNext === true;
        const singleUtterance = this.singleUtteranceTtsNext || preparedSpeechNext;
        if (
          shouldDropLlmTtsWhileClosing({
            closingCall: this.session.userData.sessionFlags.closingCall === true,
            preparedSpeechSingleUtteranceNext: preparedSpeechNext,
            singleUtteranceTtsNext: this.singleUtteranceTtsNext,
          })
        ) {
          this.singleUtteranceTtsNext = false;
          this.session.userData.preparedSpeechSingleUtteranceNext = false;
          await drainReadableStream(text);
          return voice.Agent.default.ttsNode(this, emptyTextStream(), modelSettings);
        }
        this.singleUtteranceTtsNext = false;
        this.session.userData.preparedSpeechSingleUtteranceNext = false;
        if (this.session.userData.factoryFreshLine) {
          return voice.Agent.default.ttsNode(this, text, modelSettings);
        }
        const captureLlmTts =
          conversationalRetailLine && !preparedSpeechNext && !singleUtterance;
        const ttsInput = captureLlmTts
          ? tapLlmTextStreamForTranscript(text, (spoken) => {
              pendingLlmTtsTranscript = spoken;
              lastAssistantChatText = spoken;
              debugSessionLog('B', 'agent.ts:ttsNode', 'llm_tts_text_captured', {
                textLen: spoken.length,
              });
            })
          : text;
        return voice.Agent.default.ttsNode(
          this,
          buildTtsNodeInputStream(ttsInput, {
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
      tools: caraTools.toolContext({
        vertical: orgVertical,
        demoLine: testCall,
        conversationalRetailLine,
      }),
    });

    if (conversationalRetailLine && greetingCacheWarmPromise) {
      try {
        await Promise.race([
          greetingCacheWarmPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 2500)),
        ]);
      } catch {
        /* greeting warm is best-effort */
      }
    }

    await session.start({ agent, room: ctx.room });
    if (!bareLiveKitRetailLane) {
      resetDeadAirTimer();
    }

    const aiDisclosure = resolveAiDisclosure({
      greetingText,
      niche: org.niche,
      businessType: org.agent_business_type,
      demoLine: testCall,
      conversationalOpening: conversationalRetailLine,
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
      const openingPauseMs = conversationalRetailLine
        ? RETAIL_LINE_OPENING_PAUSE_MS
        : testCall
          ? DEMO_LINE_OPENING_PAUSE_MS
          : 0;
      if (openingPauseMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, openingPauseMs));
      }
      const greetingTtsModel =
        process.env.GREETING_TTS_MODEL?.trim() || activeTtsModel;
      const greetingUsesV3 = isElevenV3Model(greetingTtsModel);
      const GREETING_CACHE_WAIT_MS = conversationalRetailLine
        ? 2000
        : greetingUsesV3
          ? 500
          : 450;
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
          greetingRetailOpening: conversationalRetailLine,
          addToChatCtx: false,
          allowInterruptions: demoExperienceStack,
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
            allowInterruptions: demoExperienceStack,
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
