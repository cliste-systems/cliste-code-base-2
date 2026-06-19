/** Matches code-base-1 voiceLegalDisclosure pattern (AI + recording notice). */
export function greetingIncludesAiDisclosure(greeting: string): boolean {
  const text = greeting.trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasAi = /\bai\b/.test(lower);
  const hasRecordingNotice =
    /\b(recorded|recording|transcribed|transcription|processed)\b/.test(lower);
  return hasAi && hasRecordingNotice;
}
