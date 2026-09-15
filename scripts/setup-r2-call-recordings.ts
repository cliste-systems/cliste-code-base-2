/**
 * One-time setup: R2 bucket for LiveKit call recording staging.
 *
 * Prerequisite: enable R2 on the Cloudflare account (Dashboard → R2 → add subscription).
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx tsx scripts/setup-r2-call-recordings.ts
 *
 * Optional smoke test after creating dashboard R2 API token:
 *   R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... npx tsx scripts/setup-r2-call-recordings.ts
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const BUCKET = 'cliste-call-recordings';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN?.trim();
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();

if (!TOKEN || !ACCOUNT_ID) {
  console.error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');
  process.exit(1);
}

const API = 'https://api.cloudflare.com/client/v4';

async function cf(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as {
    success: boolean;
    errors?: Array<{ message?: string; code?: number }>;
  };
  if (!json.success) {
    const msg = json.errors?.map((e) => e.message).join('; ') || res.statusText;
    throw new Error(msg);
  }
}

async function ensureBucket(): Promise<void> {
  try {
    await cf('PUT', `/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}`, {
      locationHint: 'weur',
    });
    console.log(`✓ Created bucket ${BUCKET} (EU West)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists|409/i.test(message)) {
      console.log(`✓ Bucket ${BUCKET} already exists`);
      return;
    }
    if (/10042|enable R2/i.test(message)) {
      throw new Error(
        'R2 is not enabled on this Cloudflare account. Open ' +
          `https://dash.cloudflare.com/${ACCOUNT_ID}/r2/overview ` +
          'and complete the free R2 subscription, then re-run this script.',
      );
    }
    throw error;
  }
}

async function testR2Upload(accessKeyId: string, secretAccessKey: string): Promise<void> {
  const endpoint = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: 'smoke-test/setup.mp3',
      Body: Buffer.from('ok'),
      ContentType: 'audio/mpeg',
    }),
  );
  console.log('✓ R2 S3 upload test passed');
  console.log('\nSet on Railway (cliste-code-base-2):');
  console.log(`CALL_RECORDING_EGRESS_S3_ACCESS_KEY=${accessKeyId}`);
  console.log(`CALL_RECORDING_EGRESS_S3_SECRET_KEY=${secretAccessKey}`);
  console.log(`CALL_RECORDING_EGRESS_S3_BUCKET=${BUCKET}`);
  console.log(`CALL_RECORDING_EGRESS_S3_ENDPOINT=${endpoint}`);
  console.log('CALL_RECORDING_EGRESS_S3_REGION=auto');
}

async function main(): Promise<void> {
  await ensureBucket();
  console.log('\nNext: create R2 S3 credentials in the dashboard');
  console.log(`https://dash.cloudflare.com/${ACCOUNT_ID}/r2/overview`);
  console.log('→ Manage R2 API tokens → Object Read & Write → scope to cliste-call-recordings');

  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  if (accessKeyId && secretAccessKey) {
    await testR2Upload(accessKeyId, secretAccessKey);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
