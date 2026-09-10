import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CaraSessionFlags } from './cara_tools.js';
import {
  advanceDemoOpening,
  DEMO_CONSENT_RETRY_MAX,
  DEMO_NAME_ASK_MAX,
  isDemoOpeningComplete,
  resolveDemoOpeningPhase,
  syncDemoOpeningPhase,
} from './demo_opening_orchestrator.js';
import { buildDemoRecordingConsentReply } from './demo_personality.js';

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

describe('demo_opening_orchestrator', () => {
  it('captures Margaret via speaking with intro', () => {
    const flags = freshOpeningFlags();
    const result = advanceDemoOpening({
      callerText: "Hey, you're speaking with Margaret.",
      flags,
    });
    assert.equal(flags.demoCallerName, 'Margaret');
    assert.equal(flags.demoRecordingConsentAsked, true);
    assert.equal(result.action.kind, 'programmatic');
    if (result.action.kind === 'programmatic') {
      assert.match(result.action.text, /record/i);
      assert.match(result.action.text, /Margaret/);
    }
    assert.equal(result.nextPhase, 'await_consent');
  });

  it('captures Brendan via my name is intro', () => {
    const flags = freshOpeningFlags();
    const result = advanceDemoOpening({
      callerText: 'Uh, my name is Brendan',
      flags,
    });
    assert.equal(flags.demoCallerName, 'Brendan');
    assert.equal(result.action.event, 'demo_recording_consent_reply');
  });

  it('stores chitchat before consent and returns a single reminder steer', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'Margaret',
      demoRecordingConsentAsked: true,
    });
    const result = advanceDemoOpening({
      callerText: "I'm not doing too bad. No, I'm doing very good.",
      flags,
    });
    assert.equal(flags.demoDeferredChitchat, "I'm not doing too bad. No, I'm doing very good.");
    assert.equal(result.action.kind, 'steer');
    assert.equal(result.action.event, 'demo_consent_chitchat_reminder');
    assert.equal(isDemoOpeningComplete(flags), false);
  });

  it('uses one steer after consent when chitchat was deferred', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'Margaret',
      demoRecordingConsentAsked: true,
      demoDeferredChitchat: "I'm not doing too bad. No, I'm doing very good.",
    });
    const result = advanceDemoOpening({
      callerText: "Yeah, that's fine.",
      flags,
    });
    assert.equal(flags.demoChitchatOpened, true);
    assert.equal(result.action.kind, 'steer');
    assert.equal(result.action.event, 'demo_after_consent_deferred_chitchat');
    assert.equal(result.nextPhase, 'open');
    assert.equal(isDemoOpeningComplete(flags), true);
  });

  it('opens with how are you keeping when no deferred chitchat', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'John',
      demoRecordingConsentAsked: true,
    });
    const result = advanceDemoOpening({
      callerText: 'Yeah, that is fine',
      flags,
    });
    assert.equal(result.action.kind, 'programmatic');
    if (result.action.kind === 'programmatic') {
      assert.match(result.action.text, /how are you keeping/i);
    }
  });

  it('caps name re-asks with programmatic copy', () => {
    const flags = freshOpeningFlags({ demoNameAskCount: DEMO_NAME_ASK_MAX - 1 });
    const result = advanceDemoOpening({
      callerText: 'What can you help with?',
      flags,
    });
    assert.equal(result.action.kind, 'programmatic');
    assert.equal(result.action.event, 'demo_ask_name_programmatic');
    assert.equal(flags.demoNameAskCount, DEMO_NAME_ASK_MAX);
  });

  it('caps consent retries with programmatic reminder', () => {
    const flags = freshOpeningFlags({
      demoCallerName: 'John',
      demoRecordingConsentAsked: true,
      demoConsentRetryCount: DEMO_CONSENT_RETRY_MAX - 1,
    });
    const result = advanceDemoOpening({
      callerText: 'Maybe later',
      flags,
    });
    assert.equal(result.action.kind, 'programmatic');
    assert.equal(result.action.event, 'demo_consent_retry_programmatic');
  });

  it('derives opening phases from flags', () => {
    const flags = freshOpeningFlags();
    assert.equal(resolveDemoOpeningPhase(flags), 'await_name');
    flags.demoRecordingConsentAsked = true;
    assert.equal(resolveDemoOpeningPhase(flags), 'await_consent');
    flags.demoChitchatOpened = true;
    assert.equal(resolveDemoOpeningPhase(flags), 'open');
    syncDemoOpeningPhase(flags);
    assert.equal(flags.demoOpeningPhase, 'open');
  });
});
