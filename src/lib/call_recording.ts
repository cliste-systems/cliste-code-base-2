import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EgressStatus,
  S3Upload,
} from 'livekit-server-sdk';

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

export function resolveCallRecordingS3Upload(): S3Upload | null {
  const accessKey =
    process.env.CALL_RECORDING_S3_ACCESS_KEY?.trim() ||
    process.env.SUPABASE_S3_ACCESS_KEY?.trim();
  const secret =
    process.env.CALL_RECORDING_S3_SECRET_KEY?.trim() ||
    process.env.SUPABASE_S3_SECRET_KEY?.trim();
  const bucket =
    process.env.CALL_RECORDING_S3_BUCKET?.trim() || CALL_RECORDINGS_BUCKET;
  const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
  const endpoint =
    process.env.CALL_RECORDING_S3_ENDPOINT?.trim() ||
    (supabaseUrl ? `${supabaseUrl}/storage/v1/s3` : '');
  const region =
    process.env.CALL_RECORDING_S3_REGION?.trim() ||
    process.env.SUPABASE_S3_REGION?.trim() ||
    'eu-west-1';

  if (!accessKey || !secret || !endpoint) return null;

  return new S3Upload({
    accessKey,
    secret,
    bucket,
    region,
    endpoint,
    forcePathStyle: true,
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
      resolveCallRecordingS3Upload(),
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
}): string | null {
  const fromResults = info.fileResults?.[0]?.location?.trim();
  if (fromResults) return fromResults;
  const legacy = info.file?.location?.trim();
  return legacy || null;
}

export async function startCallRecording(input: {
  roomName: string;
  organizationId: string;
}): Promise<string | null> {
  if (isOfflinePlayground() || !callRecordingEnabled()) return null;

  const room = input.roomName.trim();
  const organizationId = input.organizationId.trim();
  if (!room || !organizationId) return null;

  const s3 = resolveCallRecordingS3Upload();
  if (!s3) {
    console.warn('[call_recording] missing Supabase S3 credentials for LiveKit egress');
    return null;
  }

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

async function promoteStagingRecording(
  stagingPath: string,
  finalPath: string,
): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error: moveError } = await supabase.storage
    .from(CALL_RECORDINGS_BUCKET)
    .move(stagingPath, finalPath);
  if (!moveError) return true;

  const { data, error: downloadError } = await supabase.storage
    .from(CALL_RECORDINGS_BUCKET)
    .download(stagingPath);
  if (downloadError || !data) {
    console.warn('[call_recording] staging object missing', {
      stagingPath,
      moveError: moveError?.message,
      downloadError: downloadError?.message,
    });
    return false;
  }

  const body = Buffer.from(await data.arrayBuffer());
  const uploaded = await uploadRecordingToSupabase(finalPath, body);
  if (!uploaded) return false;

  await supabase.storage.from(CALL_RECORDINGS_BUCKET).remove([stagingPath]);
  return true;
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
    await client.stopEgress(egressId);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const list = await client.listEgress({ egressId });
      const info = list[0];
      if (!info) {
        await sleep(2000);
        continue;
      }

      const status = info.status;
      if (
        status === EgressStatus.EGRESS_FAILED ||
        status === EgressStatus.EGRESS_ABORTED ||
        status === EgressStatus.EGRESS_LIMIT_REACHED
      ) {
        console.warn('[call_recording] egress failed', { egressId, status });
        return null;
      }

      if (status === EgressStatus.EGRESS_COMPLETE) {
        const promoted = await promoteStagingRecording(stagingPath, storagePath);
        if (promoted) {
          const patched = await updateCallLogAudioPath(callLogId, storagePath);
          if (!patched) {
            console.warn('[call_recording] call_logs patch failed', { callLogId });
            return null;
          }
          console.info('[call_recording] stored', { callLogId, storagePath });
          return storagePath;
        }

        const downloadUrl = fileDownloadUrl(
          info as { fileResults?: EgressFileResult[]; file?: EgressFileResult },
        );
        if (!downloadUrl) {
          console.warn('[call_recording] complete without staging object or download url', {
            egressId,
            stagingPath,
          });
          return null;
        }

        const body = await downloadRecordingFile(downloadUrl);
        if (!body || body.length === 0) return null;

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

      await sleep(2000);
    }

    console.warn('[call_recording] timed out waiting for egress', { egressId });
    return null;
  } catch (error) {
    console.warn('[call_recording] finalize failed', error);
    return null;
  }
}
