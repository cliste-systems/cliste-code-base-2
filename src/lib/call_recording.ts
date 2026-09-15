import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EgressStatus,
  S3Upload,
} from 'livekit-server-sdk';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { getSupabaseClient, isOfflinePlayground } from './supabase.js';
import { updateCallLogAudioPath } from './call_logs.js';

const CALL_RECORDINGS_BUCKET = 'call-recordings';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function callRecordingStoragePath(
  organizationId: string,
  callLogId: string,
): string {
  return `${organizationId.trim()}/${callLogId.trim()}.mp3`;
}

export function callRecordingStagingPath(
  organizationId: string,
  roomName: string,
): string {
  const org = organizationId.trim();
  const safeRoom = roomName
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120);
  return `${org}/.staging/${safeRoom || 'room'}.mp3`;
}

export function isSupabaseS3Endpoint(endpoint: string | null | undefined): boolean {
  return Boolean(endpoint?.trim() && /supabase\.co/i.test(endpoint));
}

/** Supabase Storage S3 API — not compatible with LiveKit egress (SignatureDoesNotMatch). */
export function resolveSupabaseStorageS3Endpoint(
  supabaseUrl: string | null | undefined,
): string | null {
  const raw = supabaseUrl?.trim().replace(/\/$/, '');
  if (!raw) return null;

  const projectHostMatch = raw.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co$/i);
  if (projectHostMatch) {
    return `https://${projectHostMatch[1]}.storage.supabase.co/storage/v1/s3`;
  }

  return `${raw}/storage/v1/s3`;
}

type EgressS3Config = {
  accessKey: string;
  secret: string;
  bucket: string;
  region: string;
  endpoint: string;
};

function readEnv(key: string): string | null {
  const value = process.env[key]?.trim();
  return value || null;
}

/** LiveKit egress needs a real S3-compatible provider (R2, AWS S3, etc.) — not Supabase. */
export function resolveEgressS3Config(): EgressS3Config | null {
  const accessKey =
    readEnv('CALL_RECORDING_EGRESS_S3_ACCESS_KEY') ||
    readEnv('CALL_RECORDING_S3_ACCESS_KEY') ||
    readEnv('SUPABASE_S3_ACCESS_KEY');
  const secret =
    readEnv('CALL_RECORDING_EGRESS_S3_SECRET_KEY') ||
    readEnv('CALL_RECORDING_S3_SECRET_KEY') ||
    readEnv('SUPABASE_S3_SECRET_KEY');
  const bucket =
    readEnv('CALL_RECORDING_EGRESS_S3_BUCKET') ||
    readEnv('CALL_RECORDING_S3_BUCKET') ||
    CALL_RECORDINGS_BUCKET;
  const endpoint =
    readEnv('CALL_RECORDING_EGRESS_S3_ENDPOINT') ||
    readEnv('CALL_RECORDING_S3_ENDPOINT') ||
    resolveSupabaseStorageS3Endpoint(process.env.SUPABASE_URL);
  const region =
    readEnv('CALL_RECORDING_EGRESS_S3_REGION') ||
    readEnv('CALL_RECORDING_S3_REGION') ||
    readEnv('SUPABASE_S3_REGION') ||
    'auto';

  if (!accessKey || !secret || !endpoint) return null;

  if (isSupabaseS3Endpoint(endpoint)) {
    console.warn(
      '[call_recording] LiveKit egress cannot upload to Supabase Storage S3 (SignatureDoesNotMatch). ' +
        'Set CALL_RECORDING_EGRESS_S3_* to Cloudflare R2 or AWS S3; recordings are copied into Supabase after each call.',
    );
    return null;
  }

  return { accessKey, secret, bucket, region, endpoint };
}

export function resolveEgressS3Upload(): S3Upload | null {
  const config = resolveEgressS3Config();
  if (!config) return null;

  return new S3Upload({
    accessKey: config.accessKey,
    secret: config.secret,
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
  });
}

function getEgressS3Client(): S3Client | null {
  const config = resolveEgressS3Config();
  if (!config) return null;

  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secret,
    },
  });
}

function callRecordingEnabled(): boolean {
  const disabled = process.env.CALL_RECORDING_ENABLED?.trim().toLowerCase();
  if (disabled === '0' || disabled === 'false' || disabled === 'off') {
    return false;
  }
  return Boolean(
    process.env.LIVEKIT_URL?.trim() &&
      process.env.LIVEKIT_API_KEY?.trim() &&
      process.env.LIVEKIT_API_SECRET?.trim() &&
      process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() &&
      resolveEgressS3Upload(),
  );
}

function getEgressClient(): EgressClient {
  const host = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!host || !apiKey || !apiSecret) {
    throw new Error('Missing LiveKit credentials for call recording');
  }
  return new EgressClient(host, apiKey, apiSecret);
}

type EgressFileResult = {
  location?: string;
  filename?: string;
};

function fileDownloadUrl(info: {
  fileResults?: EgressFileResult[];
  file?: EgressFileResult;
  result?: { case?: string; value?: EgressFileResult };
}): string | null {
  const fromResults = info.fileResults?.[0]?.location?.trim();
  if (fromResults) return fromResults;
  const legacy = info.file?.location?.trim();
  if (legacy) return legacy;
  if (info.result?.case === 'file') {
    return info.result.value?.location?.trim() || null;
  }
  return null;
}

function egressFilename(info: {
  fileResults?: EgressFileResult[];
  file?: EgressFileResult;
  result?: { case?: string; value?: EgressFileResult };
}): string | null {
  const fromResults = info.fileResults?.[0]?.filename?.trim();
  if (fromResults) return fromResults;
  const legacy = info.file?.filename?.trim();
  if (legacy) return legacy;
  if (info.result?.case === 'file') {
    return info.result.value?.filename?.trim() || null;
  }
  return null;
}

export async function startCallRecording(input: {
  roomName: string;
  organizationId: string;
}): Promise<string | null> {
  if (isOfflinePlayground() || !callRecordingEnabled()) return null;

  const room = input.roomName.trim();
  const organizationId = input.organizationId.trim();
  if (!room || !organizationId) return null;

  const s3 = resolveEgressS3Upload();
  if (!s3) return null;

  const stagingPath = callRecordingStagingPath(organizationId, room);

  try {
    const client = getEgressClient();
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP3,
      filepath: stagingPath,
      output: {
        case: 's3',
        value: s3,
      },
    });
    const info = await client.startRoomCompositeEgress(
      room,
      { file: output },
      { audioOnly: true },
    );
    const egressId = info.egressId?.trim();
    if (!egressId) {
      console.warn('[call_recording] start returned no egress id');
      return null;
    }
    console.info('[call_recording] started', { room, egressId, stagingPath });
    return egressId;
  } catch (error) {
    console.warn('[call_recording] start failed', error);
    return null;
  }
}

async function downloadRecordingFile(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('[call_recording] download failed', res.status, url);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (error) {
    console.warn('[call_recording] download error', error);
    return null;
  }
}

async function downloadFromEgressS3(objectKey: string): Promise<Buffer | null> {
  const config = resolveEgressS3Config();
  const client = getEgressS3Client();
  if (!config || !client) return null;

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
      }),
    );
    if (!response.Body) return null;
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    console.warn('[call_recording] egress s3 download failed', { objectKey, error });
    return null;
  }
}

async function uploadRecordingToSupabase(
  storagePath: string,
  body: Buffer,
): Promise<boolean> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.storage
    .from(CALL_RECORDINGS_BUCKET)
    .upload(storagePath, body, {
      contentType: 'audio/mpeg',
      upsert: true,
    });
  if (error) {
    console.warn('[call_recording] upload failed', error.message);
    return false;
  }
  return true;
}

async function storeRecordingBody(
  callLogId: string,
  storagePath: string,
  body: Buffer,
): Promise<string | null> {
  if (body.length === 0) return null;
  const uploaded = await uploadRecordingToSupabase(storagePath, body);
  if (!uploaded) return null;

  const patched = await updateCallLogAudioPath(callLogId, storagePath);
  if (!patched) {
    console.warn('[call_recording] call_logs patch failed', { callLogId });
    return null;
  }

  console.info('[call_recording] stored', {
    callLogId,
    storagePath,
    bytes: body.length,
  });
  return storagePath;
}

/** Stop LiveKit egress as soon as the call ends so the MP3 does not include post-call silence. */
export async function stopCallRecording(egressId: string): Promise<void> {
  if (isOfflinePlayground() || !callRecordingEnabled()) return;

  const id = egressId.trim();
  if (!id) return;

  try {
    const client = getEgressClient();
    await client.stopEgress(id);
    console.info('[call_recording] stopped', { egressId: id });
  } catch (error) {
    console.warn('[call_recording] stop failed', error);
  }
}

export async function finalizeCallRecording(input: {
  egressId: string;
  organizationId: string;
  callLogId: string;
  roomName: string;
}): Promise<string | null> {
  if (isOfflinePlayground() || !callRecordingEnabled()) return null;

  const egressId = input.egressId.trim();
  const organizationId = input.organizationId.trim();
  const callLogId = input.callLogId.trim();
  const roomName = input.roomName.trim();
  if (!egressId || !organizationId || !callLogId || !roomName) return null;

  const stagingPath = callRecordingStagingPath(organizationId, roomName);
  const storagePath = callRecordingStoragePath(organizationId, callLogId);

  try {
    const client = getEgressClient();
    const activeStatuses = new Set([
      EgressStatus.EGRESS_STARTING,
      EgressStatus.EGRESS_ACTIVE,
      EgressStatus.EGRESS_ENDING,
    ]);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const list = await client.listEgress({ egressId });
      const info = list[0];
      if (!info) {
        await sleep(2000);
        continue;
      }

      const status = info.status;
      if (activeStatuses.has(status)) {
        if (attempt === 0) {
          await stopCallRecording(egressId);
        }
        await sleep(2000);
        continue;
      }

      if (
        status === EgressStatus.EGRESS_FAILED ||
        status === EgressStatus.EGRESS_ABORTED ||
        status === EgressStatus.EGRESS_LIMIT_REACHED
      ) {
        console.warn('[call_recording] egress failed', {
          egressId,
          status,
          error: info.error?.trim() || null,
          stagingPath,
        });
        return null;
      }

      if (status === EgressStatus.EGRESS_COMPLETE) {
        const egressInfo = info as {
          fileResults?: EgressFileResult[];
          file?: EgressFileResult;
          result?: { case?: string; value?: EgressFileResult };
        };

        const objectKey = egressFilename(egressInfo) || stagingPath;
        let body =
          (await downloadFromEgressS3(objectKey)) ||
          (await downloadFromEgressS3(stagingPath));

        if (!body) {
          const downloadUrl = fileDownloadUrl(egressInfo);
          if (downloadUrl) {
            body = await downloadRecordingFile(downloadUrl);
          }
        }

        return body ? storeRecordingBody(callLogId, storagePath, body) : null;
      }

      await sleep(2000);
    }

    console.warn('[call_recording] timed out waiting for egress', { egressId });
    return null;
  } catch (error) {
    console.warn('[call_recording] finalize failed', error);
    return null;
  }
}
