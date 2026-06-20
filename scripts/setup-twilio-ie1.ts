/**
 * Provision Twilio IE1 API credentials for Irish (+353) caller-facing SMS.
 *
 * Prerequisite: set TWILIO_IE1_AUTH_TOKEN (Twilio Console → Ireland region →
 * Account → API keys & tokens → Live credentials → Auth Token).
 *
 * Usage:
 *   TWILIO_IE1_AUTH_TOKEN=... npx tsx scripts/setup-twilio-ie1.ts
 *   TWILIO_IE1_AUTH_TOKEN=... npx tsx scripts/setup-twilio-ie1.ts --test +353872715938
 */
import 'dotenv/config';

import twilio from 'twilio';

import { ensureTwilioIe1MessagingRegion } from '../src/lib/twilio_ie_messaging.js';

const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
const ie1AuthToken = process.env.TWILIO_IE1_AUTH_TOKEN?.trim();
const ie1ApiKey = process.env.TWILIO_IE1_API_KEY?.trim();
const ie1ApiSecret = process.env.TWILIO_IE1_API_SECRET?.trim();
const testTo = process.argv.includes('--test')
  ? process.argv[process.argv.indexOf('--test') + 1]?.trim()
  : null;
const bloomFrom = process.env.TWILIO_PHONE_NUMBER?.trim() || '+353749389378';

async function main(): Promise<void> {
  if (!accountSid) {
    console.error('Missing TWILIO_ACCOUNT_SID.');
    process.exit(1);
  }

  const hasIe1Creds =
    Boolean(ie1AuthToken) || (Boolean(ie1ApiKey) && Boolean(ie1ApiSecret));
  if (!hasIe1Creds) {
    console.error(
      'Missing IE1 credentials.\n' +
        'Set TWILIO_IE1_API_KEY + TWILIO_IE1_API_SECRET (recommended), or TWILIO_IE1_AUTH_TOKEN.\n' +
        'Create in Twilio Console → Ireland region → Account → API keys & tokens.',
    );
    process.exit(1);
  }

  const ie1Client = ie1ApiKey && ie1ApiSecret
    ? twilio(ie1ApiKey, ie1ApiSecret, { accountSid, edge: 'dublin', region: 'ie1' })
    : twilio(accountSid, ie1AuthToken!, { accountSid, edge: 'dublin', region: 'ie1' });

  const key = await ie1Client.newKeys.create({ friendlyName: 'cara-voice-ie1-sms' });
  if (!key.sid || !key.secret) {
    console.error('Failed to create IE1 API key');
    process.exit(1);
  }

  console.log('IE1 API key created:');
  console.log(`  TWILIO_IE1_API_KEY=${key.sid}`);
  console.log(`  TWILIO_IE1_API_SECRET=${key.secret}`);
  console.log('\nSet both on Railway (worker service).');

  const region = await ensureTwilioIe1MessagingRegion(bloomFrom);
  console.log(`\nIE1 messaging region for ${bloomFrom}:`, region.ok ? 'ok' : region);

  if (testTo) {
    const smsClient = twilio(key.sid, key.secret, {
      accountSid,
      edge: 'dublin',
      region: 'ie1',
    });
    const msg = await smsClient.messages.create({
      from: bloomFrom,
      to: testTo,
      body: `Bloom Beauty Studio: https://www.fresha.com/a/bloom-beauty-studio-dublin`,
    });
    console.log('\nTest SMS sent:', { sid: msg.sid, from: msg.from, to: msg.to, status: msg.status });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
