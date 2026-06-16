import type { OrgCallConfig } from './supabase.js';

export type OrgGateResult =
  | { ok: true }
  | { ok: false; reason: string; message: string };

const BLOCKED_ACCOUNT_STATUSES = new Set(['suspended', 'churned']);
const BLOCKED_ORG_STATUSES = new Set(['suspended', 'churned']);

/**
 * Refuse LLM session when org/account is not callable (VOICE-WORKER-CONTRACT).
 */
export function assertOrgCallable(org: OrgCallConfig): OrgGateResult {
  if (!org.is_active) {
    return {
      ok: false,
      reason: 'org_inactive',
      message:
        'This line is not available right now. Please try again later or contact the business directly.',
    };
  }
  const orgStatus = (org.status ?? '').trim().toLowerCase();
  if (BLOCKED_ORG_STATUSES.has(orgStatus)) {
    return {
      ok: false,
      reason: 'org_suspended',
      message:
        'This line is not available right now. Please try again later.',
    };
  }
  const accountStatus = (org.account_status ?? '').trim().toLowerCase();
  if (BLOCKED_ACCOUNT_STATUSES.has(accountStatus)) {
    return {
      ok: false,
      reason: 'account_suspended',
      message:
        'This line is not available right now. Please try again later.',
    };
  }
  return { ok: true };
}
