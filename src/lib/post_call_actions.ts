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

const DEFAULT_POST_CALL_CALLER_NAME = 'Unknown caller';

function normalizePostCallCallerName(name: string | null | undefined): string {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || isPlaceholderCallerName(trimmed)) {
    return DEFAULT_POST_CALL_CALLER_NAME;
  }
  return trimmed;
}

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
    const action = {
      ...parsed.data,
      callerName: normalizePostCallCallerName(parsed.data.callerName),
    } as PostCallAction;

    const key = normalizeSummaryKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }

  return out;
}

function departmentSlugForPostCallAction(
  action: PostCallAction,
  summary: string,
): string | undefined {
  if (action.type === 'manager_callback') return 'management';

  const routeId = action.routeId?.trim();
  if (routeId?.startsWith('retail-bakery')) return 'bakery';
  if (routeId?.startsWith('retail-complaint')) return 'management';

  const text = summary.toLowerCase();
  if (/butcher order|meat counter|\bbutcher\b|sirloin|striploin|\bsteak/.test(text)) {
    return 'meat-counter';
  }
  if (/birthday cake|\bbakery\b|cake order/.test(text)) return 'bakery';
  if (/manager callback|complaint|speak to (?:the )?manager/.test(text)) {
    return 'management';
  }
  return undefined;
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
    summary: `Complaint — manager callback\nIssue: ${action.reason.trim()}`,
  };
}

function callerConfirmedErrand(lines: string[]): boolean {
  let sawAssistantConfirm = false;
  for (const line of lines) {
    if (/^Assistant:/i.test(line) && /\b(is that (all )?correct|is that everything|does that sound right)\b/i.test(line)) {
      sawAssistantConfirm = true;
      continue;
    }
    if (
      sawAssistantConfirm &&
      /^Caller:/i.test(line) &&
      /\b(yes|yeah|yep|correct|that's everything|that is everything|that's it|all good|perfect|spot on)\b/i.test(
        line,
      )
    ) {
      return true;
    }
  }
  return /\b(yes|yeah|that's everything|that's it)\b/i.test(
    lines.filter((line) => /^Caller:/i.test(line)).slice(-2).join(' '),
  );
}

function extractCallerNameFromTranscript(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const prev = lines[i - 1] ?? '';
    if (
      /^Assistant:/i.test(prev) &&
      /\b(your first name for collection|name for collection|who(?:'ll| will) be collecting|your name for the order)\b/i.test(
        prev,
      ) &&
      /^Caller:/i.test(line)
    ) {
      const collectingMatch = line.match(
        /^Caller:\s*(?:my name is\s+|i'm\s+|this is\s+)?([A-Za-z][A-Za-z'-]{1,30})\.?$/i,
      );
      if (collectingMatch?.[1] && !isPlaceholderCallerName(collectingMatch[1])) {
        return collectingMatch[1];
      }
    }
    const nameMatch = line.match(
      /^Caller:\s*(?:my name is\s+|i'm\s+|this is\s+)([A-Za-z][A-Za-z'-]{1,30})\.?$/i,
    );
    if (nameMatch?.[1] && !isPlaceholderCallerName(nameMatch[1])) {
      return nameMatch[1];
    }
  }
  return null;
}

function extractCakeNameFromTranscript(lines: string[], confirm: string): string | null {
  const blob = lines
    .filter((line) => line.startsWith('Caller:'))
    .map((line) => line.replace(/^Caller:\s*/i, ''))
    .join(' ');
  const happyBirthdayMatch =
    blob.match(/\bhappy birthday ([A-Za-z][A-Za-z'-]{1,24})\b/i) ??
    confirm.match(/\bhappy birthday ([A-Za-z][A-Za-z'-]{1,24})\b/i);
  if (happyBirthdayMatch?.[1]) return happyBirthdayMatch[1];

  const cakeForMatch =
    confirm.match(/\bbirthday cake for ([A-Za-z][A-Za-z'-]{1,24})\b/i) ??
    confirm.match(/\bcake for ([A-Za-z][A-Za-z'-]{1,24})\b/i);
  if (cakeForMatch?.[1]) return cakeForMatch[1];

  for (let i = 0; i < lines.length; i += 1) {
    const prev = lines[i - 1] ?? '';
    if (
      /^Assistant:/i.test(prev) &&
      /\b(name on the cake|who is it for|what name.*on the cake)\b/i.test(prev) &&
      /^Caller:/i.test(lines[i] ?? '')
    ) {
      const nameMatch = (lines[i] ?? '').match(
        /^Caller:\s*(?:my name is\s+|i'm\s+|this is\s+)?([A-Za-z][A-Za-z'-]{1,30})\.?$/i,
      );
      if (nameMatch?.[1] && !isPlaceholderCallerName(nameMatch[1])) {
        return nameMatch[1];
      }
    }
  }
  return null;
}

function extractAssistantConfirmationSummary(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (!/^Assistant:/i.test(line)) continue;
    const text = line.replace(/^Assistant:\s*/i, '').trim();
    if (!/\b(is that (all )?correct|is that everything|does that sound right)\b/i.test(text)) {
      continue;
    }
    const summary = text
      .replace(/\s+is that (all )?correct\??\s*$/i, '')
      .replace(/^lovely\s*[—-]\s*so that's\s*/i, '')
      .replace(/^right so\s*[—-]\s*/i, '')
      .replace(/^perfect\s*[—-]\s*/i, '')
      .trim();
    return summary || null;
  }
  return null;
}

function buildStructuredSummary(header: string, details: string[]): string {
  const body = details.filter(Boolean).join('\n');
  return body ? `${header}\n${body}` : header;
}

function inferFallbackActionFromTranscript(
  lines: string[],
  callerName: string,
): PostCallAction | null {
  const callerLines = lines
    .filter((line) => line.startsWith('Caller:'))
    .map((line) => line.replace(/^Caller:\s*/i, ''));
  const blob = callerLines.join(' ').toLowerCase();
  const assistantConfirm = extractAssistantConfirmationSummary(lines);

  const managerMatch = blob.match(
    /\b(speak to (?:the )?manager|store manager|complaint|unhappy|refund|delivery never arrived)\b/,
  );
  if (managerMatch) {
    return {
      type: 'manager_callback',
      callerName,
      reason: callerLines.join(' ').slice(0, 500),
    };
  }

  const handoffMatch = blob.match(
    /\b(order|callback|call back|ring me|phone me|in stock|birthday|cake|butcher|deli|complaint|steak|sirloin)\b/,
  );
  if (!handoffMatch && !assistantConfirm) return null;
  if (!callerConfirmedErrand(lines) && !assistantConfirm) return null;

  if (/\bbirthday cake\b|\bcake order\b|\border for a cake\b/.test(blob) || /\bbirthday cake\b/i.test(assistantConfirm ?? '')) {
    const confirm = assistantConfirm ?? callerLines.join(' ').trim();
    const cakeForName = extractCakeNameFromTranscript(lines, confirm);
    const whenMatch = confirm.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[^,.]*/i);
    const peopleMatch = confirm.match(/\bfor (\d{1,3}) people\b/i);
    const messageMatch = confirm.match(/"([^"]+)"/);
    const icingMatch = confirm.match(/\b(blue|pink|white|chocolate|vanilla)[^,.]*icing\b/i);
    const collectingName =
      callerName !== DEFAULT_POST_CALL_CALLER_NAME ? callerName : null;
    return {
      type: 'action_ticket',
      callerName: collectingName ?? DEFAULT_POST_CALL_CALLER_NAME,
      summary: buildStructuredSummary('Birthday cake order', [
        cakeForName ? `For: ${cakeForName}` : '',
        collectingName ? `Collecting: ${collectingName}` : '',
        whenMatch?.[0] ? `When: ${whenMatch[0].trim()}` : '',
        peopleMatch?.[1] ? `Size: ${peopleMatch[1]} people` : '',
        messageMatch?.[1] ? `Message: ${messageMatch[1]}` : '',
        icingMatch?.[0] ? `Notes: ${icingMatch[0]}` : confirm ? `Details: ${confirm.slice(0, 240)}` : '',
      ]),
      routeId: 'retail-bakery-cake',
    };
  }

  if (/\bbutcher\b|\bsirloin\b|\bsteak\b/.test(blob)) {
    return {
      type: 'action_ticket',
      callerName,
      summary: buildStructuredSummary('Butcher order — callback', [
        `Details: ${(assistantConfirm ?? callerLines.join(' ')).slice(0, 500)}`,
      ]),
    };
  }

  const detail = (assistantConfirm ?? callerLines.join(' ')).trim().slice(0, 500);
  if (!detail) return null;

  return {
    type: 'action_ticket',
    callerName,
    summary: buildStructuredSummary('Customer request', [`Details: ${detail}`]),
  };
}

/** Rule-based fallback when post-call LLM returns no actions but transcript shows a completed order. */
export function fallbackExtractPostCallActions(verbatim: string): PostCallAction[] {
  const lines = verbatim.split('\n').map((l) => l.trim()).filter(Boolean);
  const callerName = normalizePostCallCallerName(extractCallerNameFromTranscript(lines));
  const action = inferFallbackActionFromTranscript(lines, callerName);
  return action ? [action] : [];
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
      const routeId =
        action.type === 'action_ticket' ? action.routeId?.trim() : undefined;
      await insertActionTicket({
        organizationId: input.organizationId,
        calledNumber: input.calledNumber,
        callerNumber: input.callerNumber,
        callerName: callerName === DEFAULT_POST_CALL_CALLER_NAME ? undefined : callerName,
        summary,
        routeId,
        departmentSlug: departmentSlugForPostCallAction(action, summary),
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
