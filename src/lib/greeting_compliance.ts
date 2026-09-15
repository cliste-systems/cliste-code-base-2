import {
  VOICE_ASSISTANT_DEFAULT_NAME,
  voiceLegalDisclosure,
} from './voice_legal_disclosure.js';

/** Whether spoken or configured text includes AI identification and recording notice. */
export function greetingDisclosesAi(
  greeting: string,
  assistantDisplayName = VOICE_ASSISTANT_DEFAULT_NAME,
): boolean {
  const trimmed = greeting.trim();
  if (!trimmed) return false;

  const legal = voiceLegalDisclosure(assistantDisplayName);
  if (trimmed.includes(legal)) return true;

  const lower = trimmed.toLowerCase();
  const name = assistantDisplayName.trim().toLowerCase() || 'cara';
  const hasAiDisclosure =
    /\b(ai assistant|virtual assistant|automated assistant|artificial intelligence)\b/i.test(
      lower,
    );
  const namesAssistant = lower.includes(name) || lower.includes('cara');
  const mentionsRecording =
    /\b(recorded|transcribed|recording|transcript)\b/i.test(lower);

  return hasAiDisclosure && namesAssistant && mentionsRecording;
}

/** @deprecated Use greetingDisclosesAi — kept for existing imports. */
export function greetingIncludesAiDisclosure(
  greeting: string,
  assistantDisplayName = VOICE_ASSISTANT_DEFAULT_NAME,
): boolean {
  return greetingDisclosesAi(greeting, assistantDisplayName);
}

/** Demo / deferred notice — recording awareness without requiring AI in the same line. */
export function spokenTextIncludesRecordingNotice(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  return /\b(recorded|recording|transcribed|transcription|record calls|record this|recorded for quality|this demo'?s recorded|call'?s recorded)\b/i.test(
    lower,
  );
}

export function spokenTextIncludesLegalDisclosure(
  text: string,
  assistantDisplayName = VOICE_ASSISTANT_DEFAULT_NAME,
): boolean {
  return greetingDisclosesAi(text, assistantDisplayName);
}
