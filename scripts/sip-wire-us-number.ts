/**
 * Wire `TWILIO_PHONE_NUMBER` (E.164) to your SIP dispatch rule. Requires `lk` CLI.
 *
 * Run: npx tsx scripts/sip-wire-us-number.ts
 */
import 'dotenv/config';

import { execSync } from 'node:child_process';

import { ListUpdate, RoomAgentDispatch, RoomConfiguration, SIPDispatchRuleInfo } from '@livekit/protocol';
import { SipClient } from 'livekit-server-sdk';

const LEGACY_US_E164 = '+14843040166';

function httpsHost(): string {
  const u = process.env.LIVEKIT_URL;
  if (!u) {
    throw new Error('Missing LIVEKIT_URL');
  }
  return u.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

async function main(): Promise<void> {
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!key || !secret) {
    throw new Error('Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET');
  }

  const e164 = process.env.TWILIO_PHONE_NUMBER?.trim() || LEGACY_US_E164;
  console.info('Wiring number', e164);

  const sip = new SipClient(httpsHost(), key, secret);
  const agentName = process.env.LIVEKIT_AGENT_NAME?.trim() || 'cliste-salon-node';
  const jobMetadata = JSON.stringify({ organization_slug: 'admin-salon' });

  const trunks = await sip.listSipInboundTrunk();
  const trunk =
    trunks.find((t) => (t.numbers ?? []).some((n) => n.includes('353'))) ?? trunks[0];
  if (!trunk?.sipTrunkId) {
    throw new Error('No inbound SIP trunk found');
  }

  const nums = trunk.numbers ?? [];
  if (!nums.includes(e164)) {
    await sip.updateSipInboundTrunkFields(trunk.sipTrunkId, {
      numbers: new ListUpdate({ add: [e164] }),
    });
    console.info('Trunk', trunk.sipTrunkId, '— added', e164);
  } else {
    console.info('Trunk', trunk.sipTrunkId, '—', e164, 'already listed');
  }

  const rules = await sip.listSipDispatchRule();
  const rule =
    rules.find((r) => (r.trunkIds ?? []).includes(trunk.sipTrunkId)) ??
    rules.find((r) => /cliste/i.test(r.name ?? '')) ??
    rules[0];

  if (!rule?.sipDispatchRuleId) {
    throw new Error('No SIP dispatch rule found');
  }

  const next = rule.clone() as SIPDispatchRuleInfo;
  next.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName,
        metadata: jobMetadata,
      }),
    ],
  });

  await sip.updateSipDispatchRule(rule.sipDispatchRuleId, next);
  console.info(
    'Dispatch rule',
    rule.sipDispatchRuleId,
    '(',
    rule.name,
    ') — agent',
    agentName,
    'metadata',
    jobMetadata,
  );

  execSync(
    `lk number update --number ${e164} --sip-dispatch-rule-id ${rule.sipDispatchRuleId}`,
    { stdio: 'inherit', env: process.env },
  );
  console.info('Cloud phone number', e164, '→ dispatch rule', rule.sipDispatchRuleId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
