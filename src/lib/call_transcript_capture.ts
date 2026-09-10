import { voice } from '@livekit/agents';

import type { CaraAgentUserData } from './cara_tools.js';
import {
  truncateForTranscript,
  type TranscriptLine,
  TOOL_TRANSCRIPT_SNIPPET_MAX,
} from './finalize_call_session.js';

const TRANSCRIPT_DEDUPE_MS = 3000;

export type CallTranscriptCapture = {
  parts: TranscriptLine[];
  appendCallerLine: (text: string, at: number) => void;
  appendAssistantLine: (text: string, at: number, interrupted?: boolean) => void;
};

export function createCallTranscriptCapture(): CallTranscriptCapture {
  const parts: TranscriptLine[] = [];
  let seq = 0;
  const recentCaller = new Map<string, number>();
  const recentAssistant = new Map<string, number>();

  const appendLine = (at: number, line: string) => {
    parts.push({ at, seq: seq++, line });
  };

  const normalizeKey = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

  const shouldSkipDuplicate = (map: Map<string, number>, key: string, at: number) => {
    const prev = map.get(key);
    if (prev !== undefined && at - prev < TRANSCRIPT_DEDUPE_MS) return true;
    map.set(key, at);
    return false;
  };

  return {
    parts,
    appendCallerLine(text: string, at: number) {
      const key = normalizeKey(text);
      if (shouldSkipDuplicate(recentCaller, key, at)) return;
      appendLine(at, `Caller: ${text}`);
    },
    appendAssistantLine(text: string, at: number, interrupted = false) {
      const key = normalizeKey(text);
      if (shouldSkipDuplicate(recentAssistant, key, at)) return;
      const note = interrupted ? ' [cut off]' : '';
      appendLine(at, `Assistant: ${text}${note}`);
    },
  };
}

export function wireCallTranscriptHandlers(
  session: voice.AgentSession<CaraAgentUserData>,
  capture: CallTranscriptCapture,
): void {
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (!ev.isFinal) return;
    const text = ev.transcript?.trim();
    if (!text) return;
    capture.appendCallerLine(text, ev.createdAt);
  });

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    const { item } = ev;
    if (item.type !== 'message') return;
    const { role } = item;
    if (role === 'developer' || role === 'system') return;
    const text = item.textContent?.trim();
    if (!text) return;
    if (role === 'user') {
      capture.appendCallerLine(text, ev.createdAt);
      return;
    }
    if (role === 'assistant') {
      capture.appendAssistantLine(text, ev.createdAt, item.interrupted);
    }
  });

  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
    for (const [call, out] of voice.zipFunctionCallsAndOutputs(ev)) {
      if (call.name === 'endPhoneCall') {
        session.userData.sessionFlags.closingCall = true;
      }
      capture.parts.push({
        at: call.createdAt ?? ev.createdAt,
        seq: capture.parts.length,
        line: `[Tool] ${call.name} ${truncateForTranscript(call.args, TOOL_TRANSCRIPT_SNIPPET_MAX)}`,
      });
      if (out) {
        const prefix = out.isError ? '[Tool error] ' : '[Tool result] ';
        capture.parts.push({
          at: out.createdAt,
          seq: capture.parts.length,
          line: `${prefix}${truncateForTranscript(out.output, TOOL_TRANSCRIPT_SNIPPET_MAX)}`,
        });
      }
    }
  });
}
