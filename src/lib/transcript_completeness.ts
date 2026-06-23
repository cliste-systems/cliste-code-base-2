/** Placeholder text that must never appear in a persisted verbatim export. */
export const TRANSCRIPT_PARTIAL_MARKERS: readonly RegExp[] = [
  /\(inferred\)/i,
  /STT not in Railway logs/i,
  /Reconstructed from Railway/i,
];

export type TranscriptCompleteness = {
  complete: boolean;
  reasons: string[];
  callerLineCount: number;
  assistantLineCount: number;
};

export function assessTranscriptCompleteness(
  transcript: string | null | undefined,
): TranscriptCompleteness {
  const reasons: string[] = [];
  const text = transcript?.trim() ?? '';

  if (!text) {
    reasons.push('transcript is empty');
  }

  for (const marker of TRANSCRIPT_PARTIAL_MARKERS) {
    if (marker.test(text)) {
      reasons.push(`contains placeholder (${marker.source})`);
    }
  }

  const callerLineCount = (text.match(/^Caller: /gm) ?? []).length;
  const assistantLineCount = (text.match(/^Assistant: /gm) ?? []).length;

  if (text && callerLineCount === 0) {
    reasons.push('no Caller: lines');
  }
  if (text && assistantLineCount === 0) {
    reasons.push('no Assistant: lines');
  }

  return {
    complete: reasons.length === 0,
    reasons,
    callerLineCount,
    assistantLineCount,
  };
}
