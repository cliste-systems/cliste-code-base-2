import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EgressStatus,
} from 'livekit-server-sdk';

import { getSupabaseClient, isOfflinePlayground } from './supabase.js';
import { updateCallLogAudioPath } from './call_logs.js';

const CALL_RECORDINGS_BUCKET = 'call-recordings';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
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

export function callRecordingStoragePath(
  organizationId: string,
  callLogId: string,
): string {
  return `${organizationId.trim()}/${callLogId.trim()}.mp3`;
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

export async function startCallRecording(roomName: string): Promise<string | null> {
  if (isOfflinePlayground() || !callRecordingEnabled()) return null;
  const room = roomName.trim();
  if (!room) return null;

  try {
    const client = getEgressClient();
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP3,
      filepath: `call-recordings/${room}-${Date.now()}.mp3`,
    });
    const info = await client.startRoomCompositeEgress(room, output, {
      audioOnly: true,
    });
    const egressId = info.egressId?.trim();
    if (!egressId) {
      console.warn('[call_recording] start returned no egress id');
      return null;
    }
    console.info('[call_recording] started', { room, egressId });
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

export async function finalizeCallRecording(input: {
  egressId: string;
  organizationId: string;
  callLogId: string;
}): Promise<string | null> {
  if (isOfflinePlayground() || !callRecordingEnabled()) return null;

  const egressId = input.egressId.trim();
  const organizationId = input.organizationId.trim();
  const callLogId = input.callLogId.trim();
  if (!egressId || !organizationId || !callLogId) return null;

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
        const downloadUrl = fileDownloadUrl(info as { fileResults?: EgressFileResult[]; file?: EgressFileResult });
        if (!downloadUrl) {
          console.warn('[call_recording] complete without download url', { egressId });
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

        console.info('[call_recording] stored', { callLogId, storagePath, bytes: body.length });
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
