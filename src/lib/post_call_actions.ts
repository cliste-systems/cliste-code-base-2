import { z } from 'zod';

import { isPlaceholderCallerName } from './conversational_retail_policy.js';
import { insertActionTicket } from './action_tickets.js';

const actionTicketSchema = z.object({
  type: z.literal('action_ticket'),
  callerName: z.string().min(2),
  summary: z.string().min(20),
  routeId: z.string().optional(),
});

const managerCallbackSchema = z.object({
  type: z.literal('manager_callback'),
  callerName: z.string().min(2),
  reason: z.string().min(10),
});

const postCallActionSchema = z.discriminatedUnion('type', [
  actionTicketSchema,
  managerCallbackSchema,
]);

export type PostCallAction = z.infer<typeof postCallActionSchema>;

export type ExecutePostCallActionsResult = {
  actionTicketCreated: boolean;
  executed: PostCallAction[];
  errors: string[];
};

function normalizeSummaryKey(action: PostCallAction): string {
  if (action.type === 'action_ticket') {
    return `${action.callerName.toLowerCase()}|${action.summary.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  }
  return `${action.callerName.toLowerCase()}|manager|${action.reason.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

/** Validate and dedupe post-call actions from LLM JSON. */
export function normalizePostCallActions(raw: unknown): PostCallAction[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: PostCallAction[] = [];

  for (const entry of raw) {
    const parsed = postCallActionSchema.safeParse(entry);
    if (!parsed.success) continue;
    const action = parsed.data;
    if (isPlaceholderCallerName(action.callerName)) continue;

    const key = normalizeSummaryKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }

  return out;
}

function actionToTicketSummary(action: PostCallAction): { callerName: string; summary: string } {
  if (action.type === 'action_ticket') {
    return {
      callerName: action.callerName.trim(),
      summary: action.summary.trim(),
    };
  }
  return {
    callerName: action.callerName.trim(),
    summary: `Manager callback requested: ${action.reason.trim()}`,
  };
}

/** Rule-based fallback when post-call LLM returns no actions but transcript shows a completed order. */
export function fallbackExtractPostCallActions(verbatim: string): PostCallAction[] {
  const lines = verbatim.split('\n').map((l) => l.trim()).filter(Boolean);
  let callerName: string | null = null;
  const callerLines: string[] = [];

  for (const line of lines) {
    const nameMatch = line.match(/^Caller:\s*(?:my name is\s+)?([A-Za-z][A-Za-z'-]{1,30})\.?$/i);
    if (nameMatch?.[1] && !isPlaceholderCallerName(nameMatch[1])) {
      callerName = nameMatch[1];
    }
    if (line.startsWith('Caller:')) {
      callerLines.push(line.replace(/^Caller:\s*/i, ''));
    }
  }

  const blob = callerLines.join(' ').toLowerCase();
  const looksLikeCake =
    /\b(cake|birthday cake|bakery)\b/.test(blob) &&
    /\b(order|birthday|happy birthday)\b/.test(blob);

  if (!looksLikeCake || !callerName) return [];

  const dateMatch = blob.match(
    /\b(\d{1,2}(?:st|nd|rd|th)?(?:\s+of\s+next\s+month)?|\d{1,2}\/\d{1,2})\b/,
  );
  const messageMatch = blob.match(/happy birthday[, ]+([a-z]+)/i);
  const servingsMatch = blob.match(/\b(\d{1,2})\b/);

  const parts: string[] = ['Birthday cake order'];
  if (messageMatch?.[1]) parts.push(`message: Happy Birthday ${messageMatch[1]}`);
  if (dateMatch?.[1]) parts.push(`date: ${dateMatch[1]}`);
  if (servingsMatch?.[1]) parts.push(`servings: ${servingsMatch[1]}`);

  return [
    {
      type: 'action_ticket',
      callerName,
      summary: parts.join('; '),
      routeId: 'retail-bakery-cake',
    },
  ];
}

export async function executePostCallActions(input: {
  organizationId: string;
  calledNumber: string;
  callerNumber: string;
  actions: PostCallAction[];
}): Promise<ExecutePostCallActionsResult> {
  const executed: PostCallAction[] = [];
  const errors: string[] = [];
  let actionTicketCreated = false;

  for (const action of input.actions) {
    try {
      const { callerName, summary } = actionToTicketSummary(action);
      const routeNote =
        action.type === 'action_ticket' && action.routeId?.trim()
          ? ` [route: ${action.routeId.trim()}]`
          : '';
      await insertActionTicket({
        organizationId: input.organizationId,
        calledNumber: input.calledNumber,
        callerNumber: input.callerNumber,
        callerName,
        summary: `${summary}${routeNote}`,
        engineeringPriority: 'urgent',
      });
      executed.push(action);
      actionTicketCreated = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      console.error('[post_call_actions] execute failed', { action, message: msg });
    }
  }

  return { actionTicketCreated, executed, errors };
}
