import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CaraSessionFlags } from './cara_tools.js';
import { DEFAULT_DEMO_SCENARIOS } from './demo_scenarios.js';
import {
  advanceDemoOpening,
  isDemoOpeningComplete,
} from './demo_opening_orchestrator.js';
import {
  countDemoTurnSpeechActions,
  resolveDemoTurnAction,
} from './demo_turn_arbiter.js';

function freshOpeningFlags(overrides: Partial<CaraSessionFlags> = {}): CaraSessionFlags {
  return {
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
    demoDeferredChitchat: null,
    demoNameAskCount: 0,
    demoConsentRetryCount: 0,
    demoOpeningPhase: 'greeting',
    demoPersonalityNameAskUsed: false,
    ...overrides,
  };
}

function resolveTurn(
  callerText: string,
  flags: CaraSessionFlags,
  opts?: { agentSpeaking?: boolean; callEnding?: boolean },
) {
  return resolveDemoTurnAction({
    callerText,
    flags,
    demoScenarios: DEFAULT_DEMO_SCENARIOS,
    callEnding: opts?.callEnding ?? false,
    agentSpeaking: opts?.agentSpeaking ?? false,
  });
}

describe('demo_turn_arbiter golden paths', () => {
  it('Path 0b — Margaret intro yields one consent programmatic action', () => {
    const flags = freshOpeningFlags();
    const resolution = resolveTurn("Hey, you're speaking with Margaret.", flags);
    assert.equal(countDemoTurnSpeechActions(resolution.action), 1);
    assert.equal(resolution.action.kind, 'opening');
    assert.equal(resolution.action.openingAction?.kind, 'programmatic');
    assert.equal(flags.demoCallerName, 'Margaret');
    assert.equal(resolution.action.blockFramework, true);
    assert.equal(resolution.action.scheduleGuarantee, false);
  });

  it('Path 0b — chitchat before consent yields one consent reminder steer', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'Margaret',
      demoRecordingConsentAsked: true,
    });
    const resolution = resolveTurn("I'm not doing too bad. No, I'm doing very good.", flags);
    assert.equal(countDemoTurnSpeechActions(resolution.action), 1);
    assert.equal(resolution.action.kind, 'opening');
    assert.equal(resolution.action.openingAction?.kind, 'steer');
    assert.equal(resolution.action.openingAction?.event, 'demo_consent_chitchat_reminder');
    assert.equal(isDemoOpeningComplete(flags), false);
  });

  it('Path 0b — consent after deferred chitchat yields one steer only', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'Margaret',
      demoRecordingConsentAsked: true,
      demoDeferredChitchat: "I'm not doing too bad. No, I'm doing very good.",
    });
    const resolution = resolveTurn("Yeah, that's fine.", flags);
    assert.equal(countDemoTurnSpeechActions(resolution.action), 1);
    assert.equal(resolution.action.openingAction?.event, 'demo_after_consent_deferred_chitchat');
    assert.equal(isDemoOpeningComplete(flags), true);
  });

  it('consent without deferred chitchat asks how are you keeping once', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'John',
      demoRecordingConsentAsked: true,
    });
    const resolution = resolveTurn('Yeah, that is fine', flags);
    assert.equal(countDemoTurnSpeechActions(resolution.action), 1);
    assert.equal(resolution.action.openingAction?.event, 'demo_after_consent_reply');
    if (resolution.action.openingAction?.kind === 'programmatic') {
      assert.match(resolution.action.openingAction.text, /how are you keeping/i);
    }
  });

  it('Mary regression — exact transcript turn is one wellbeing ack', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'Mary',
      demoRecordingConsentAsked: true,
      demoChitchatOpened: true,
      demoAwaitingWellbeingReply: true,
    });
    const resolution = resolveTurn('Oh, keeping pretty good, and yourself?', flags);
    assert.equal(countDemoTurnSpeechActions(resolution.action), 1);
    assert.equal(resolution.action.kind, 'programmatic');
    assert.equal(resolution.action.event, 'demo_wellbeing_ack');
    if (resolution.action.programmaticText) {
      assert.doesNotMatch(resolution.action.programmaticText, /\?/);
      assert.doesNotMatch(resolution.action.programmaticText, /mind today|business|assist/i);
    }
  });

  it('Mary regression — full sequence never double-speaks on a single turn', () => {
    const flags = freshOpeningFlags();
    const turns = [
      "Hey, you're speaking with Mary.",
      "Yeah, that's fine.",
      "I'm doing grand, thanks.",
    ];
    for (const text of turns) {
      const resolution = resolveTurn(text, flags);
      assert.ok(
        countDemoTurnSpeechActions(resolution.action) <= 1,
        `double-speak on: ${text}`,
      );
    }
  });

  it('Brendan intro captures name via my name is', () => {
    const flags = freshOpeningFlags();
    const resolution = resolveTurn('Uh, my name is Brendan', flags);
    assert.equal(flags.demoCallerName, 'Brendan');
    assert.equal(countDemoTurnSpeechActions(resolution.action), 1);
    assert.equal(resolution.action.openingAction?.event, 'demo_recording_consent_reply');
  });

  it('post-open product question yields one steer', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'Brendan',
      demoRecordingConsentAsked: true,
      demoChitchatOpened: true,
    });
    advanceDemoOpening({ callerText: 'Yeah fine', flags });
    flags.demoAwaitingWellbeingReply = false;
    const resolution = resolveTurn('What is it that you do?', flags);
    assert.equal(countDemoTurnSpeechActions(resolution.action), 1);
    assert.equal(resolution.action.kind, 'steer');
    assert.equal(resolution.action.event, 'demo_about_question');
  });

  it('blocks second programmatic line while agent is speaking', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'Mary',
      demoRecordingConsentAsked: true,
      demoChitchatOpened: true,
      demoAwaitingWellbeingReply: true,
    });
    const resolution = resolveTurn("I'm good", flags, { agentSpeaking: true });
    assert.equal(countDemoTurnSpeechActions(resolution.action), 0);
    assert.equal(resolution.action.event, 'demo_turn_agent_speaking');
  });

  it('demo menu question yields one steer not two paths', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'John',
      demoRecordingConsentAsked: true,
      demoChitchatOpened: true,
    });
    flags.demoAwaitingWellbeingReply = false;
    const resolution = resolveTurn('What can we demo today?', flags);
    assert.equal(countDemoTurnSpeechActions(resolution.action), 1);
    assert.equal(resolution.action.event, 'demo_menu_question');
  });

  it('electrician motivation yields one steer', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'John',
      demoRecordingConsentAsked: true,
      demoChitchatOpened: true,
    });
    flags.demoAwaitingWellbeingReply = false;
    const resolution = resolveTurn('Can we demo an electrician?', flags);
    assert.equal(countDemoTurnSpeechActions(resolution.action), 1);
    assert.equal(resolution.action.event, 'demo_motivation');
    assert.equal(flags.demoScenarioSlug, 'electrician');
  });
});

describe('demo_turn_arbiter guarantee scheduling', () => {
  it('schedules guarantee only when opening is complete and turn unhandled', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'John',
      demoRecordingConsentAsked: true,
      demoChitchatOpened: true,
      demoScenarioSlug: 'electrician',
      demoScenarioBeat: 2,
    });
    flags.demoAwaitingWellbeingReply = false;
    const resolution = resolveTurn('…', flags);
    assert.equal(resolution.action.kind, 'none');
    assert.equal(resolution.action.scheduleGuarantee, true);
  });
});
