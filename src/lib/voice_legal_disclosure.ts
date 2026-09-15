export const VOICE_ASSISTANT_DEFAULT_NAME = 'Cara';

export function assistantNameLabel(name: string): string {
  const trimmed = name.trim();
  return trimmed || VOICE_ASSISTANT_DEFAULT_NAME;
}

/** Fixed GDPR / AI Act disclosure — matches code-base-1 voiceLegalDisclosure(). */
export function voiceLegalDisclosure(
  assistantDisplayName: string = VOICE_ASSISTANT_DEFAULT_NAME,
): string {
  const assistant = assistantNameLabel(assistantDisplayName);
  return `I'm ${assistant}, the AI assistant. This call may be recorded and transcribed.`;
}
