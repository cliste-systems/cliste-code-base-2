export const STT_RECOVERY_SPEECH_LINE =
  "Sorry — I'm having a brief technical hitch. Bear with me one moment.";

export const STT_FAILURE_AI_SUMMARY =
  'Call dropped — STT rate limit or connection failure. Caller may have heard partial greeting only.';

export function isSttRateLimitOrTransientError(message: string, err?: unknown): boolean {
  const haystack = `${message} ${formatUnknownError(err)}`.toLowerCase();
  if (/\b429\b/.test(haystack)) return true;
  if (/\b503\b/.test(haystack)) return true;
  if (haystack.includes('rate limit')) return true;
  if (haystack.includes('too many requests')) return true;
  if (haystack.includes('unexpected server response: 429')) return true;
  return false;
}

export function classifySttPipelineError(message: string, err?: unknown): {
  retryable: boolean;
  statusCode?: number;
} {
  const haystack = `${message} ${formatUnknownError(err)}`;
  const statusMatch = haystack.match(/\bstatusCode["']?\s*[:=]\s*(\d{3})\b/i)
    ?? haystack.match(/unexpected server response:\s*(\d{3})/i)
    ?? haystack.match(/\b(\d{3})\b/);
  const statusCode = statusMatch ? Number.parseInt(statusMatch[1]!, 10) : undefined;
  const retryable =
    statusCode === 429 ||
    statusCode === 503 ||
    statusCode === 502 ||
    isSttRateLimitOrTransientError(message, err);
  if (statusCode !== undefined) {
    return { retryable, statusCode };
  }
  return { retryable };
}

export function resolveCallOutcomeWithSttFailure(input: {
  transcriptLineCount: number;
  sttFailureDetected: boolean;
}): { outcome: string; aiSummary: string } | null {
  if (input.sttFailureDetected && input.transcriptLineCount === 0) {
    return { outcome: 'stt_failure', aiSummary: STT_FAILURE_AI_SUMMARY };
  }
  return null;
}

function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return '';
}
