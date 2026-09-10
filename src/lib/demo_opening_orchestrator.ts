import type { CaraSessionFlags } from './cara_tools.js';
import {
  buildDemoAfterConsentReply,
  buildDemoAskNameAgainReply,
  buildDemoAskNameSteer,
  buildDemoRecordingConsentProgrammaticReminder,
  buildDemoRecordingConsentReminderSteer,
  buildDemoRecordingConsentReply,
  buildDemoRecordingConsentRetrySteer,
  buildDemoRecordingDeclineSteer,
  buildDemoAfterConsentDeferredSteer,
  extractDemoCallerNameResponse,
} from './demo_personality.js';
import {
  callerSoundsLikeAffirmativeConsent,
  callerSoundsLikeAudioCheck,
  callerSoundsLikeRecordingDecline,
  callerSoundsLikeVagueDemoOpening,
} from './speech_triggers.js';

export type DemoOpeningPhase = 'greeting' | 'await_name' | 'await_consent' | 'open';

export const DEMO_NAME_ASK_MAX = 3;
export const DEMO_CONSENT_RETRY_MAX = 3;

export type DemoOpeningAction =
  | { kind: 'programmatic'; text: string; event: string }
  | { kind: 'steer'; instructions: string; event: string }
  | { kind: 'none'; event: string };

export function resolveDemoOpeningPhase(flags: CaraSessionFlags): DemoOpeningPhase {
  if (flags.demoChitchatOpened) return 'open';
  if (flags.demoRecordingConsentAsked) return 'await_consent';
  return 'await_name';
}

export function syncDemoOpeningPhase(flags: CaraSessionFlags): DemoOpeningPhase {
  const phase = resolveDemoOpeningPhase(flags);
  flags.demoOpeningPhase = phase;
  return phase;
}

export function isDemoOpeningComplete(flags: CaraSessionFlags): boolean {
  return flags.demoChitchatOpened === true;
}

export type AdvanceDemoOpeningInput = {
  callerText: string;
  flags: CaraSessionFlags;
};

export type AdvanceDemoOpeningResult = {
  action: DemoOpeningAction;
  phase: DemoOpeningPhase;
  nextPhase?: DemoOpeningPhase;
};

function callerSoundsLikePreConsentChitchat(text: string): boolean {
  if (callerSoundsLikeAffirmativeConsent(text) || callerSoundsLikeRecordingDecline(text)) {
    return false;
  }
  return callerSoundsLikeVagueDemoOpening(text);
}

function consentRetryUsesProgrammatic(flags: CaraSessionFlags): boolean {
  return (flags.demoConsentRetryCount ?? 0) >= DEMO_CONSENT_RETRY_MAX;
}

function bumpConsentRetry(flags: CaraSessionFlags): void {
  flags.demoConsentRetryCount = (flags.demoConsentRetryCount ?? 0) + 1;
}

function handleAwaitConsent(
  text: string,
  flags: CaraSessionFlags,
  phase: DemoOpeningPhase,
): AdvanceDemoOpeningResult {
  const name = flags.demoCallerName ?? 'there';

  if (callerSoundsLikeAffirmativeConsent(text)) {
    flags.demoChitchatOpened = true;
    const deferred = flags.demoDeferredChitchat?.trim();
    flags.demoDeferredChitchat = null;
    if (deferred) {
      return {
        action: {
          kind: 'steer',
          instructions: buildDemoAfterConsentDeferredSteer(name, deferred),
          event: 'demo_after_consent_deferred_chitchat',
        },
        phase,
        nextPhase: 'open',
      };
    }
    return {
      action: {
        kind: 'programmatic',
        text: buildDemoAfterConsentReply(name),
        event: 'demo_after_consent_reply',
      },
      phase,
      nextPhase: 'open',
    };
  }

  if (callerSoundsLikeRecordingDecline(text)) {
    return {
      action: {
        kind: 'steer',
        instructions: buildDemoRecordingDeclineSteer(),
        event: 'demo_consent_decline',
      },
      phase,
    };
  }

  if (callerSoundsLikePreConsentChitchat(text)) {
    flags.demoDeferredChitchat = text.trim();
    bumpConsentRetry(flags);
    if (consentRetryUsesProgrammatic(flags)) {
      return {
        action: {
          kind: 'programmatic',
          text: buildDemoRecordingConsentProgrammaticReminder(),
          event: 'demo_consent_retry_programmatic',
        },
        phase,
      };
    }
    return {
      action: {
        kind: 'steer',
        instructions: buildDemoRecordingConsentReminderSteer(),
        event: 'demo_consent_chitchat_reminder',
      },
      phase,
    };
  }

  bumpConsentRetry(flags);
  if (consentRetryUsesProgrammatic(flags)) {
    return {
      action: {
        kind: 'programmatic',
        text: buildDemoRecordingConsentProgrammaticReminder(),
        event: 'demo_consent_retry_programmatic',
      },
      phase,
    };
  }
  return {
    action: {
      kind: 'steer',
      instructions: buildDemoRecordingConsentRetrySteer(),
      event: 'demo_consent_retry',
    },
    phase,
  };
}

function handleAwaitName(
  text: string,
  flags: CaraSessionFlags,
  phase: DemoOpeningPhase,
): AdvanceDemoOpeningResult {
  const volunteeredName = extractDemoCallerNameResponse(text);
  if (volunteeredName) {
    flags.demoCallerName = volunteeredName;
    flags.demoNameBanterUsed = true;
    flags.demoPostNameSteerUsed = true;
    flags.demoRecordingConsentAsked = true;
    return {
      action: {
        kind: 'programmatic',
        text: buildDemoRecordingConsentReply(volunteeredName),
        event: 'demo_recording_consent_reply',
      },
      phase,
      nextPhase: 'await_consent',
    };
  }

  if (callerSoundsLikeAudioCheck(text)) {
    flags.demoNameAskCount = (flags.demoNameAskCount ?? 0) + 1;
    if ((flags.demoNameAskCount ?? 0) >= DEMO_NAME_ASK_MAX) {
      return {
        action: {
          kind: 'programmatic',
          text: buildDemoAskNameAgainReply(),
          event: 'demo_ask_name_programmatic',
        },
        phase,
      };
    }
    return {
      action: {
        kind: 'steer',
        instructions: buildDemoAskNameSteer(text, { audioCheck: true }),
        event: 'demo_ask_name_steer',
      },
      phase,
    };
  }

  if (callerSoundsLikePreConsentChitchat(text)) {
    flags.demoDeferredChitchat = text.trim();
  }
  flags.demoNameAskCount = (flags.demoNameAskCount ?? 0) + 1;
  if ((flags.demoNameAskCount ?? 0) >= DEMO_NAME_ASK_MAX) {
    return {
      action: {
        kind: 'programmatic',
        text: buildDemoAskNameAgainReply(),
        event: 'demo_ask_name_programmatic',
      },
      phase,
    };
  }
  return {
    action: {
      kind: 'steer',
      instructions: buildDemoAskNameSteer(text),
      event: 'demo_ask_name_steer',
    },
    phase,
  };
}

export function advanceDemoOpening(input: AdvanceDemoOpeningInput): AdvanceDemoOpeningResult {
  const { callerText, flags } = input;
  const text = callerText.trim();
  const phase = resolveDemoOpeningPhase(flags);

  if (phase === 'open') {
    return { action: { kind: 'none', event: 'demo_opening_complete' }, phase };
  }

  if (phase === 'await_consent') {
    return handleAwaitConsent(text, flags, phase);
  }

  return handleAwaitName(text, flags, phase);
}

export function formatDemoOpeningDiagMeta(
  action: DemoOpeningAction,
  phase: DemoOpeningPhase,
  nextPhase?: DemoOpeningPhase,
): Record<string, unknown> {
  return {
    phase,
    nextPhase: nextPhase ?? null,
    actionKind: action.kind,
    event: action.event,
  };
}
