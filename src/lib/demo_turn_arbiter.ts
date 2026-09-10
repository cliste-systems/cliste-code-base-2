import type { CaraSessionFlags } from './cara_tools.js';
import {
  advanceDemoOpening,
  isDemoOpeningComplete,
  resolveDemoOpeningPhase,
  syncDemoOpeningPhase,
  type DemoOpeningAction,
  type DemoOpeningPhase,
} from './demo_opening_orchestrator.js';
import {
  buildDemoConversationalReplySteer,
  buildDemoFollowMotivationSteer,
  buildDemoWellbeingAckReply,
  callerSoundsLikeHelloCaraMotivation,
} from './demo_personality.js';
import { detectDemoScenario, type DemoScenario } from './demo_scenarios.js';
import {
  classifyHelloCaraAboutQuestion,
  helloCaraAboutSteerInstructions,
} from './hello_cara_website_facts.js';

type HelloCaraAboutTopic = NonNullable<ReturnType<typeof classifyHelloCaraAboutQuestion>>;
import { callerSoundsLikeAudioCheck, callerAsksDemoMenu, callerSoundsLikeVagueDemoOpening } from './speech_triggers.js';

export type DemoTurnSpeechKind = 'none' | 'opening' | 'programmatic' | 'steer' | 'typing_sound';

export type DemoTurnAction = {
  kind: DemoTurnSpeechKind;
  event: string;
  openingAction?: DemoOpeningAction;
  programmaticText?: string;
  steerInstructions?: string;
  /** Exactly one speech path per caller turn when true. */
  handled: boolean;
  blockFramework: boolean;
  scheduleGuarantee: boolean;
};

export type DemoTurnDiagEvent = {
  level: 'info' | 'warn';
  event: string;
  meta?: Record<string, unknown>;
};

export type DemoTurnResolution = {
  action: DemoTurnAction;
  openingPhase?: DemoOpeningPhase;
  openingPhaseTransition?: { from: DemoOpeningPhase; to: DemoOpeningPhase; event: string };
  disclosureConfirmed?: boolean;
  openingActionMeta?: Record<string, unknown>;
  diagEvents: DemoTurnDiagEvent[];
};

export type ResolveDemoTurnInput = {
  callerText: string;
  flags: CaraSessionFlags;
  demoScenarios: DemoScenario[];
  callEnding: boolean;
  agentSpeaking: boolean;
};

const BLOCKED: DemoTurnAction = {
  kind: 'none',
  event: 'demo_turn_blocked',
  handled: false,
  blockFramework: true,
  scheduleGuarantee: false,
};

const UNHANDLED_OPEN: DemoTurnAction = {
  kind: 'none',
  event: 'demo_turn_unhandled_open',
  handled: false,
  blockFramework: true,
  scheduleGuarantee: true,
};

function handledAction(
  partial: Omit<DemoTurnAction, 'handled' | 'blockFramework' | 'scheduleGuarantee'>,
): DemoTurnAction {
  return {
    ...partial,
    handled: partial.kind !== 'none' && partial.kind !== 'typing_sound',
    blockFramework: true,
    scheduleGuarantee: false,
  };
}

function buildOpeningActionMeta(
  openingAction: DemoOpeningAction,
  callerText: string,
  flags: CaraSessionFlags,
): Record<string, unknown> | undefined {
  if (openingAction.event === 'demo_recording_consent_reply') {
    return { name: flags.demoCallerName };
  }
  if (openingAction.event === 'demo_ask_name_steer') {
    return {
      kind: callerSoundsLikeAudioCheck(callerText) ? 'audio_check' : 'awaiting_name',
      attempt: flags.demoNameAskCount,
    };
  }
  if (
    openingAction.event === 'demo_after_consent_deferred_chitchat' ||
    openingAction.event === 'demo_after_consent_reply'
  ) {
    return { name: flags.demoCallerName ?? 'there' };
  }
  if (openingAction.event === 'demo_ask_name_programmatic') {
    return { attempts: flags.demoNameAskCount };
  }
  return undefined;
}

function startGeneralScenario(
  flags: CaraSessionFlags,
  about: HelloCaraAboutTopic | null,
  snippet: string,
): DemoTurnDiagEvent {
  if (!flags.demoScenarioSlug) {
    flags.demoScenarioSlug = 'general';
    flags.demoScenarioBeat = about === 'who-made' ? 2 : 1;
  }
  return {
    level: 'info',
    event: 'demo_scenario_start',
    meta: { slug: 'general', snippet: snippet.slice(0, 120), about: about ?? undefined },
  };
}

/** Pure demo-line turn decision — returns at most one speech action per caller turn. */
export function resolveDemoTurnAction(input: ResolveDemoTurnInput): DemoTurnResolution {
  const { callerText, flags, demoScenarios, callEnding, agentSpeaking } = input;
  const text = callerText.trim();
  const diagEvents: DemoTurnDiagEvent[] = [];

  if (callEnding || !text) {
    return { action: BLOCKED, diagEvents };
  }

  if (agentSpeaking) {
    return {
      action: {
        kind: 'none',
        event: 'demo_turn_agent_speaking',
        handled: false,
        blockFramework: true,
        scheduleGuarantee: false,
      },
      diagEvents,
    };
  }

  if (!isDemoOpeningComplete(flags)) {
    const priorPhase = syncDemoOpeningPhase(flags);
    const wasOpen = flags.demoChitchatOpened === true;
    const result = advanceDemoOpening({ callerText: text, flags });
    const nextPhase = syncDemoOpeningPhase(flags);
    const openingPhaseTransition =
      result.nextPhase && result.nextPhase !== priorPhase
        ? { from: priorPhase, to: result.nextPhase, event: result.action.event }
        : undefined;

    if (openingPhaseTransition) {
      diagEvents.push({
        level: 'info',
        event: 'demo_opening_phase',
        meta: openingPhaseTransition,
      });
    }

    const action =
      result.action.kind === 'none'
        ? { ...UNHANDLED_OPEN, event: result.action.event }
        : handledAction({
            kind: 'opening',
            event: result.action.event,
            openingAction: result.action,
          });

    const openingActionMeta = buildOpeningActionMeta(result.action, text, flags);

    return {
      action,
      openingPhase: nextPhase,
      ...(openingPhaseTransition ? { openingPhaseTransition } : {}),
      ...(!wasOpen && flags.demoChitchatOpened ? { disclosureConfirmed: true as const } : {}),
      ...(openingActionMeta ? { openingActionMeta } : {}),
      diagEvents,
    };
  }

  if (flags.demoAwaitingWellbeingReply) {
    flags.demoAwaitingWellbeingReply = false;
    return {
      action: handledAction({
        kind: 'programmatic',
        event: 'demo_wellbeing_ack',
        programmaticText: buildDemoWellbeingAckReply(text),
      }),
      diagEvents,
    };
  }

  const about = classifyHelloCaraAboutQuestion(text);
  if (about) {
    diagEvents.push(startGeneralScenario(flags, about, text));
    return {
      action: handledAction({
        kind: 'steer',
        event: 'demo_about_question',
        steerInstructions: helloCaraAboutSteerInstructions(about),
      }),
      diagEvents,
    };
  }

  if (callerAsksDemoMenu(text) && !flags.demoScenarioSlug) {
    flags.demoScenarioSlug = 'general';
    flags.demoScenarioBeat = 1;
    diagEvents.push({
      level: 'info',
      event: 'demo_scenario_start',
      meta: { slug: 'general', snippet: text.slice(0, 120) },
    });
    return {
      action: handledAction({
        kind: 'steer',
        event: 'demo_menu_question',
        steerInstructions:
          'The caller asked what they can demo. ONE warm conversational line (~18 words). Do NOT list trades. Continue naturally — reflect the chat so far, then gently explore what kind of business they have in mind.',
      }),
      diagEvents,
    };
  }

  if (!flags.demoScenarioSlug && callerSoundsLikeVagueDemoOpening(text)) {
    flags.demoAwaitingWellbeingReply = false;
    return {
      action: handledAction({
        kind: 'steer',
        event: 'demo_vague_opening',
        steerInstructions: buildDemoConversationalReplySteer(text),
      }),
      diagEvents,
    };
  }

  const detected = detectDemoScenario(text, demoScenarios);
  if (
    !flags.demoScenarioSlug &&
    (callerSoundsLikeHelloCaraMotivation(text) || detected)
  ) {
    flags.demoScenarioSlug = detected ?? 'general';
    flags.demoScenarioBeat = 1;
    diagEvents.push({
      level: 'info',
      event: 'demo_motivation_steer',
      meta: { slug: flags.demoScenarioSlug, snippet: text.slice(0, 120) },
    });
    return {
      action: handledAction({
        kind: 'steer',
        event: 'demo_motivation',
        steerInstructions: buildDemoFollowMotivationSteer(text, detected),
      }),
      diagEvents,
    };
  }

  if (
    !flags.demoScenarioSlug &&
    !callerSoundsLikeVagueDemoOpening(text) &&
    !callerAsksDemoMenu(text) &&
    !callerSoundsLikeHelloCaraMotivation(text) &&
    !detected
  ) {
    return {
      action: handledAction({
        kind: 'steer',
        event: 'demo_conversational',
        steerInstructions: buildDemoConversationalReplySteer(text),
      }),
      diagEvents,
    };
  }

  if (flags.demoScenarioSlug && (flags.demoScenarioBeat ?? 0) === 3) {
    return {
      action: {
        kind: 'typing_sound',
        event: 'demo_scenario_typing',
        handled: false,
        blockFramework: true,
        scheduleGuarantee: true,
      },
      diagEvents,
    };
  }

  return {
    action: UNHANDLED_OPEN,
    openingPhase: resolveDemoOpeningPhase(flags),
    diagEvents,
  };
}

/** Count speech actions that would reach the caller — must stay <= 1 per resolution. */
export function countDemoTurnSpeechActions(action: DemoTurnAction): number {
  if (action.kind === 'opening') {
    if (!action.openingAction || action.openingAction.kind === 'none') return 0;
    return 1;
  }
  if (action.kind === 'programmatic' || action.kind === 'steer') return 1;
  return 0;
}
