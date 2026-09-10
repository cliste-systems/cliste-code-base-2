import type { CaraSessionFlags } from './cara_tools.js';
import {
  formatDemoOpeningDiagMeta,
  syncDemoOpeningPhase,
  type DemoOpeningAction,
} from './demo_opening_orchestrator.js';
import type { DemoTurnAction, DemoTurnDiagEvent, DemoTurnResolution } from './demo_turn_arbiter.js';

export type DemoSpeechExecutorDeps = {
  flags: CaraSessionFlags;
  isCallEnding: () => boolean;
  cancelInFlightReply: () => void;
  clearDemoReplyGuaranteeTimers: () => void;
  clearCallerReplyNudgeTimer: () => void;
  clearGreetingInterruptFallbackTimer: () => void;
  sayPrepared: (text: string, opts?: { allowInterruptions?: boolean; addToChatCtx?: boolean }) => void;
  steerReply: (instructions: string) => void;
  onDisclosureConfirmed: () => void;
  onWellbeingQuestionAsked: () => void;
  pushDiag: (level: DemoTurnDiagEvent['level'], event: string, meta?: Record<string, unknown>) => void;
};

function executeOpeningAction(
  action: DemoOpeningAction,
  meta: Record<string, unknown> | undefined,
  deps: DemoSpeechExecutorDeps,
): void {
  if (deps.isCallEnding() || action.kind === 'none') return;

  deps.clearGreetingInterruptFallbackTimer();
  deps.clearDemoReplyGuaranteeTimers();
  deps.clearCallerReplyNudgeTimer();
  deps.cancelInFlightReply();

  deps.pushDiag('info', 'demo_opening_action', {
    ...formatDemoOpeningDiagMeta(action, syncDemoOpeningPhase(deps.flags)),
    ...meta,
  });

  if (action.kind === 'programmatic') {
    deps.pushDiag('info', action.event, meta ?? {});
    if (action.event === 'demo_after_consent_reply') {
      deps.onWellbeingQuestionAsked();
    }
    deps.sayPrepared(action.text, {
      allowInterruptions: true,
      addToChatCtx: true,
    });
    return;
  }

  deps.pushDiag('info', action.event, meta ?? {});
  deps.steerReply(action.instructions);
}

/** Execute exactly one demo turn action — the only demo speech entry point. */
export function executeDemoTurnAction(
  resolution: DemoTurnResolution,
  deps: DemoSpeechExecutorDeps,
): boolean {
  const { action, disclosureConfirmed, openingActionMeta, diagEvents } = resolution;

  for (const ev of diagEvents) {
    deps.pushDiag(ev.level, ev.event, ev.meta);
  }

  if (disclosureConfirmed) {
    deps.onDisclosureConfirmed();
  }

  if (action.kind === 'none' || action.kind === 'typing_sound') {
    return action.handled;
  }

  if (action.kind === 'opening' && action.openingAction) {
    executeOpeningAction(action.openingAction, openingActionMeta, deps);
    return true;
  }

  if (action.kind === 'programmatic' && action.programmaticText) {
    deps.clearDemoReplyGuaranteeTimers();
    deps.clearCallerReplyNudgeTimer();
    deps.cancelInFlightReply();
    deps.pushDiag('info', action.event, {});
    deps.sayPrepared(action.programmaticText, {
      allowInterruptions: true,
      addToChatCtx: true,
    });
    return true;
  }

  if (action.kind === 'steer' && action.steerInstructions) {
    deps.pushDiag('info', action.event, {});
    deps.steerReply(action.steerInstructions);
    return true;
  }

  return action.handled;
}

export function shouldScheduleDemoGuaranteeTimers(action: DemoTurnAction): boolean {
  return action.scheduleGuarantee;
}

export function shouldBlockDemoFrameworkAutoReply(_action: DemoTurnAction): boolean {
  return true;
}
