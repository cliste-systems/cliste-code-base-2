export type PostCallStatus = 'pending' | 'complete' | 'partial' | 'failed';

export type PostCallErrorStage =
  | 'insert'
  | 'postprocess'
  | 'action_ticket'
  | 'enrichment'
  | 'webhook'
  | 'close_handler';

export type PostCallErrorEntry = {
  stage: PostCallErrorStage;
  message: string;
  at: string;
};

export type ActionTicketDeliveryStatus = 'confirmed' | 'pending_review' | 'failed';

export function appendPostCallError(
  existing: PostCallErrorEntry[],
  stage: PostCallErrorStage,
  message: string,
): PostCallErrorEntry[] {
  return [
    ...existing,
    { stage, message: message.slice(0, 500), at: new Date().toISOString() },
  ];
}

export function computeFinalPostCallStatus(input: {
  errors: PostCallErrorEntry[];
  expectedTicket: boolean;
  actionTicketCreated: boolean;
  callLogId: string | null;
}): PostCallStatus {
  if (!input.callLogId) return 'failed';
  if (input.errors.length === 0) {
    if (input.expectedTicket && !input.actionTicketCreated) return 'failed';
    return 'complete';
  }
  if (input.expectedTicket && !input.actionTicketCreated) return 'failed';
  return 'partial';
}

export async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T | null | false>,
  attempts = 3,
): Promise<{ value: T | null; error: string | null }> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await fn();
      if (value === false || value === null) {
        lastError = `${label} returned empty on attempt ${attempt}`;
      } else {
        return { value, error: null };
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (attempt < attempts) {
      await sleepMs(150 * attempt);
    }
  }
  return { value: null, error: lastError };
}

export class PostCallProcessingTracker {
  readonly errors: PostCallErrorEntry[] = [];
  expectedTicket = false;

  record(stage: PostCallErrorStage, message: string): void {
    this.errors.splice(0, this.errors.length, ...appendPostCallError(this.errors, stage, message));
  }

  finalize(input: {
    actionTicketCreated: boolean;
    callLogId: string | null;
  }): PostCallStatus {
    return computeFinalPostCallStatus({
      errors: this.errors,
      expectedTicket: this.expectedTicket,
      actionTicketCreated: input.actionTicketCreated,
      callLogId: input.callLogId,
    });
  }
}

export const PLACEHOLDER_TICKET_SUMMARY_PREFIX =
  'Under review — our team is confirming the order details from this call.';
