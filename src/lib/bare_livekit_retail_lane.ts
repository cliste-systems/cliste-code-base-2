import { isConversationalRetailLine } from './conversational_retail_line.js';

/** Kavanaghs 9508 — LiveKit AgentSession turn loop only; no programmatic guard rails in agent.ts. */
export function isBareLiveKitRetailLane(calledNumber: string | null | undefined): boolean {
  return isConversationalRetailLine(calledNumber);
}

/** Programmatic guard rails intentionally disabled on the bare LiveKit retail lane. */
export const BARE_LIVEKIT_DISABLED_PROGRAMMATIC_GUARDS = [
  'resetDeadAirTimer',
  'scheduleCallerReplyNudge',
  'scheduleGreetingInterruptFallback',
  'retryFailedReplyOnce',
  'steerReply',
  'playPipelineRecoverySpeech',
  'maybeCloseAfterAnythingElse',
] as const;
