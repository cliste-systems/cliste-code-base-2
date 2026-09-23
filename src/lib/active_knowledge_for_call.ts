/**
 * Live active knowledge for calls — loaded fresh from the database each call.
 * Same source of truth as the dashboard temporal system; not the compiled custom_prompt snapshot.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type ActiveTemporalRow = {
  id: string;
  title: string;
  body: string;
  subject_type: string;
  subject_ref: string | null;
  override_preview: unknown;
  duration_mode: string;
  effective_at: string;
  expires_at: string | null;
  ended_at: string | null;
  cancelled_at: string | null;
};

type TemporalOverridePreview = {
  normalLabel?: string;
  normalBody?: string | null;
  temporaryLabel?: string;
  temporaryBody?: string;
  scopeLabel?: string;
};

function isSchemaCacheError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('schema cache') ||
    m.includes('does not exist') ||
    m.includes('could not find') ||
    m.includes('relation')
  );
}

function parsePreview(raw: unknown): TemporalOverridePreview | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const normalLabel = String(row.normalLabel ?? '').trim();
  const temporaryLabel = String(row.temporaryLabel ?? '').trim();
  const temporaryBody = String(row.temporaryBody ?? '').trim();
  const scopeLabel = String(row.scopeLabel ?? '').trim();
  return {
    ...(normalLabel ? { normalLabel } : {}),
    normalBody:
      row.normalBody == null ? null : String(row.normalBody).trim() || null,
    ...(temporaryLabel ? { temporaryLabel } : {}),
    ...(temporaryBody ? { temporaryBody } : {}),
    ...(scopeLabel ? { scopeLabel } : {}),
  };
}

export function isTemporalRowEffective(row: ActiveTemporalRow, now: Date = new Date()): boolean {
  if (row.cancelled_at || row.ended_at) return false;
  const effectiveAt = new Date(row.effective_at);
  if (Number.isNaN(effectiveAt.getTime()) || effectiveAt > now) return false;
  if (row.duration_mode === 'ongoing') return true;
  if (!row.expires_at) return true;
  const expiresAt = new Date(row.expires_at);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt > now;
}

export async function loadActiveTemporalUpdates(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ActiveTemporalRow[]> {
  const { data, error } = await supabase
    .from('cara_knowledge_temporal_updates')
    .select(
      'id, title, body, subject_type, subject_ref, override_preview, duration_mode, effective_at, expires_at, ended_at, cancelled_at',
    )
    .eq('organization_id', organizationId)
    .is('cancelled_at', null)
    .is('ended_at', null)
    .order('effective_at', { ascending: false })
    .limit(100);

  if (error) {
    if (isSchemaCacheError(error.message)) return [];
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    subject_type: String(row.subject_type ?? ''),
    subject_ref: row.subject_ref ? String(row.subject_ref) : null,
    override_preview: row.override_preview ?? null,
    duration_mode: String(row.duration_mode ?? 'limited'),
    effective_at: String(row.effective_at ?? ''),
    expires_at: row.expires_at ? String(row.expires_at) : null,
    ended_at: row.ended_at ? String(row.ended_at) : null,
    cancelled_at: row.cancelled_at ? String(row.cancelled_at) : null,
  }));
}

/** Prompt block injected on every call — overrides stale compiled custom_prompt. */
export function buildActiveKnowledgeBlockForCall(input: {
  temporalRows: ActiveTemporalRow[];
  structuredHoursBlock?: string | null;
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const effective = input.temporalRows.filter((row) => isTemporalRowEffective(row, now));
  const structuredHours = input.structuredHoursBlock?.trim() ?? '';

  if (effective.length === 0 && !structuredHours) return null;

  const lines: string[] = [
    '## Active knowledge (live — loaded at call start)',
    'These entries override everything below — including the compiled business instructions, FAQs, and usual opening hours. Never contradict them.',
  ];

  if (structuredHours) {
    lines.push('', '### Opening hours (structured + any temporary override)', structuredHours);
  }

  if (effective.length > 0) {
    lines.push('', '### Temporary updates');
    for (const row of effective) {
      const preview = parsePreview(row.override_preview);
      if (preview?.temporaryBody) {
        const usual = preview.normalBody ? ` Usual: ${preview.normalBody}.` : '';
        lines.push(
          `- ${preview.temporaryLabel ?? row.title}: ${preview.temporaryBody}.${usual}`,
        );
      } else {
        lines.push(`- ${row.title}: ${row.body}`);
      }
    }
  }

  return lines.join('\n');
}
