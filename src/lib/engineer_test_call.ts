const ENGINEER_TEST_CALLER_E164 = '+353870000001';
const ADMIN_DEMO_ROOM_PREFIX = 'admin-demo-';

function parseMetadataAdminSimulator(metadata: string | null | undefined): boolean {
  if (!metadata?.trim()) return false;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return parsed.source === 'admin_simulator';
  } catch {
    return false;
  }
}

export function isEngineerTestCallerNumber(
  callerNumber: string | null | undefined,
): boolean {
  return (callerNumber ?? '').trim() === ENGINEER_TEST_CALLER_E164;
}

export function isEngineerTestRoomName(roomName: string | null | undefined): boolean {
  return (roomName ?? '').trim().startsWith(ADMIN_DEMO_ROOM_PREFIX);
}

/** Admin browser simulator — tenant-visible test only; not billed. */
export function isEngineerTestCall(input: {
  callerNumber?: string | null;
  roomName?: string | null;
  jobMetadata?: string | null;
  roomMetadata?: string | null;
}): boolean {
  if (parseMetadataAdminSimulator(input.jobMetadata)) return true;
  if (parseMetadataAdminSimulator(input.roomMetadata)) return true;
  if (isEngineerTestCallerNumber(input.callerNumber)) return true;
  if (isEngineerTestRoomName(input.roomName)) return true;
  return false;
}
