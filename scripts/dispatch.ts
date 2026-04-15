/**
 * Explicit agent dispatch: npm run dispatch -- <room-name> [organization_slug]
 */
import 'dotenv/config';

import { AgentDispatchClient } from 'livekit-server-sdk';

function httpsHost(): string {
  const u = process.env.LIVEKIT_URL;
  if (!u) {
    throw new Error('Missing LIVEKIT_URL');
  }
  return u.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

async function main(): Promise<void> {
  const room = process.argv[2];
  if (!room?.trim()) {
    console.error('Usage: npm run dispatch -- <room-name> [organization_slug]');
    process.exit(1);
  }
  const slugArg = process.argv[3]?.trim();

  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!key || !secret) {
    throw new Error('Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET');
  }

  const agentName = process.env.LIVEKIT_AGENT_NAME?.trim() || 'cliste-salon-node';
  const client = new AgentDispatchClient(httpsHost(), key, secret);

  let metadata: string | undefined;
  if (slugArg) {
    metadata = JSON.stringify({ organization_slug: slugArg });
  } else if (process.env.DEFAULT_SALON_PHONE?.trim()) {
    metadata = JSON.stringify({ phone_number: process.env.DEFAULT_SALON_PHONE.trim() });
  }

  const dispatch = await client.createDispatch(room.trim(), agentName, metadata ? { metadata } : {});
  console.info('Dispatch created', dispatch);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
