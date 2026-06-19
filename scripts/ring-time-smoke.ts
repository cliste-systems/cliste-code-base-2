/**
 * Ring-time integration smoke test — org load → gate → Cara prompt → routing parse.
 *
 * Usage:
 *   RING_SMOKE_SLUG=my-business npx tsx scripts/ring-time-smoke.ts
 *   RING_SMOKE_PHONE=+353... npx tsx scripts/ring-time-smoke.ts
 */
import 'dotenv/config';

import { buildCaraCallPrompt } from '../src/lib/cara_prompt.js';
import { CaraTools } from '../src/lib/cara_tools.js';
import { classifyCallerLine } from '../src/lib/phone_classify.js';
import { assertOrgCallable } from '../src/lib/org_gate.js';
import {
  getOrgForCall,
  getSendableBusinessFiles,
  resolveOrgTimeZone,
  resolveOrgVoiceId,
} from '../src/lib/supabase.js';
import { activeRoutes, fallbackRoute } from '../src/lib/routing_links.js';

function fail(message: string): never {
  console.error(`[ring-smoke] FAIL: ${message}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`[ring-smoke] ok: ${message}`);
}

async function main(): Promise<void> {
  const slug = process.env.RING_SMOKE_SLUG?.trim();
  const phone = process.env.RING_SMOKE_PHONE?.trim();
  if (!slug && !phone) {
    fail('Set RING_SMOKE_SLUG or RING_SMOKE_PHONE');
  }

  const org = await getOrgForCall({
    ...(slug ? { slug } : {}),
    ...(phone ? { phone } : {}),
  });
  if (!org) {
    fail(`No organization for slug=${slug ?? ''} phone=${phone ?? ''}`);
  }
  ok(`loaded org ${org.id} (${org.name})`);

  const gate = assertOrgCallable(org);
  if (!gate.ok) {
    fail(`org not callable: ${gate.reason}`);
  }
  ok('org gate passed');

  const businessFiles = await getSendableBusinessFiles(org.id);
  const routingLinks = CaraTools.parseLinks(org.routing_links);
  const bookingTz = resolveOrgTimeZone(org);
  const voiceId = resolveOrgVoiceId(org);

  ok(
    `mode=cara routes=${activeRoutes(routingLinks).length} files=${businessFiles.length}`,
  );
  ok(`timezone=${bookingTz} voiceId=${voiceId ?? '(env fallback)'}`);

  if (!org.custom_prompt?.trim()) {
    fail('custom_prompt is empty — run onboarding / Cara Setup compile');
  }
  ok(`custom_prompt chars=${org.custom_prompt.trim().length}`);

  const now = new Date();
  const callerLine = classifyCallerLine(phone ?? '+353871234567');
  const todayLocal = now.toLocaleDateString('en-GB', { timeZone: bookingTz });

  const prompt = buildCaraCallPrompt({
    businessName: org.name,
    customPrompt: org.custom_prompt.trim(),
    callerLine,
    bookingTimeZone: bookingTz,
    nowUtcIso: now.toISOString(),
    todayLocal,
  });

  if (prompt.length < 200) {
    fail('system prompt unexpectedly short');
  }
  ok(`system prompt chars=${prompt.length}`);

  const fb = fallbackRoute(routingLinks);
  if (!fb) {
    console.warn('[ring-smoke] warn: no fallback route in routing_links');
  } else {
    ok(`fallback route: ${fb.intent || fb.label}`);
  }

  const caraTools = new CaraTools();
  const toolNames = Object.keys(caraTools.toolContext());
  if (toolNames.length < 5) {
    fail(`expected Cara tools, got: ${toolNames.join(', ')}`);
  }
  ok(`cara tools: ${toolNames.join(', ')}`);

  console.log('[ring-smoke] PASS');
}

main().catch((err) => {
  console.error('[ring-smoke] error', err);
  process.exit(1);
});
