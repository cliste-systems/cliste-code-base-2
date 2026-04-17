/**
 * GDPR Art 17 — right to erasure / right to be forgotten.
 *
 * Wipes per-caller PII for a phone number across the voice-agent tables:
 *   - call_logs.transcript / transcript_review / ai_summary  → null
 *   - call_logs.caller_number                                → 'erased'
 *   - action_tickets.caller_number                           → 'erased'
 *   - action_tickets.summary                                 → '[erased on request]'
 *   - appointments.customer_name                             → 'Erased'
 *   - appointments.customer_phone                            → 'erased'
 *   - appointments.customer_email                            → null  (if column exists)
 *
 * The booking ROW itself is preserved so the salon's diary still shows that a
 * slot was used (Art 17(3)(b) — exercise of legal claims / business records).
 * Only the personal-data columns are blanked.
 *
 * Usage:
 *   npx tsx scripts/gdpr-erase.ts +353871234567
 *   npx tsx scripts/gdpr-erase.ts +353871234567 --dry-run
 *
 * Phone normalisation matches the agent: Irish national 087… → +35387…
 */
import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';

function usage(): never {
  console.error('Usage: tsx scripts/gdpr-erase.ts <phone> [--dry-run]');
  process.exit(2);
}

function normalisePhone(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('+')) {
    return t;
  }
  const d = t.replace(/\D/g, '');
  if (d.startsWith('353') && d.length >= 11) {
    return `+${d}`;
  }
  if (d.startsWith('0') && (d.length === 10 || d.length === 11)) {
    return `+353${d.slice(1)}`;
  }
  if (d.length >= 10) {
    return `+${d}`;
  }
  return t;
}

/** Phone-number variants we will match against — covers both stored formats. */
function lookupVariants(e164: string): string[] {
  const out = new Set<string>([e164]);
  const digits = e164.replace(/\D/g, '');
  if (digits.startsWith('353')) {
    out.add(`0${digits.slice(3)}`);
    out.add(`353${digits.slice(3)}`);
  }
  return [...out];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
  }
  const phone = args[0]!;
  const dryRun = args.includes('--dry-run');
  const e164 = normalisePhone(phone);
  const variants = lookupVariants(e164);

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  console.log(`Erasing PII for phone ${e164} (matching ${variants.join(', ')}) — dry-run=${dryRun}`);

  const callLogs = await supabase
    .from('call_logs')
    .select('id, organization_id, created_at')
    .in('caller_number', variants);
  if (callLogs.error) {
    console.error('call_logs lookup failed', callLogs.error);
    process.exit(1);
  }
  console.log(`call_logs matched: ${callLogs.data?.length ?? 0}`);

  const actionTickets = await supabase
    .from('action_tickets')
    .select('id, organization_id, created_at')
    .in('caller_number', variants);
  if (actionTickets.error) {
    console.error('action_tickets lookup failed', actionTickets.error);
    process.exit(1);
  }
  console.log(`action_tickets matched: ${actionTickets.data?.length ?? 0}`);

  const appointments = await supabase
    .from('appointments')
    .select('id, organization_id, booking_reference, start_time')
    .in('customer_phone', variants);
  if (appointments.error) {
    console.error('appointments lookup failed', appointments.error);
    process.exit(1);
  }
  console.log(`appointments matched: ${appointments.data?.length ?? 0}`);

  if (dryRun) {
    console.log('--dry-run set; not modifying any rows.');
    return;
  }

  // Wipe transcripts + caller_number on call_logs.
  if ((callLogs.data?.length ?? 0) > 0) {
    const { error } = await supabase
      .from('call_logs')
      .update({
        transcript: null,
        transcript_review: null,
        ai_summary: null,
        caller_number: 'erased',
      })
      .in('caller_number', variants);
    if (error) {
      console.error('call_logs update failed', error);
      process.exit(1);
    }
    console.log('call_logs: PII columns nulled, caller_number set to "erased".');
  }

  // Wipe summary + caller_number on action_tickets.
  if ((actionTickets.data?.length ?? 0) > 0) {
    const { error } = await supabase
      .from('action_tickets')
      .update({
        caller_number: 'erased',
        summary: '[erased on request]',
      })
      .in('caller_number', variants);
    if (error) {
      console.error('action_tickets update failed', error);
      process.exit(1);
    }
    console.log('action_tickets: caller_number + summary erased.');
  }

  // Blank PII columns on appointments — keep the row + booking_reference.
  if ((appointments.data?.length ?? 0) > 0) {
    const update: Record<string, unknown> = {
      customer_name: 'Erased',
      customer_phone: 'erased',
    };
    // Best-effort attempt at customer_email column (present in code-base-1).
    const tryWithEmail = await supabase
      .from('appointments')
      .update({ ...update, customer_email: null })
      .in('customer_phone', variants);
    if (tryWithEmail.error) {
      // Fall back without email column if it doesn't exist on this DB.
      const { error } = await supabase
        .from('appointments')
        .update(update)
        .in('customer_phone', variants);
      if (error) {
        console.error('appointments update failed', error);
        process.exit(1);
      }
    }
    console.log('appointments: PII columns blanked (booking row kept).');
  }

  console.log('Erasure complete.');
}

void main();
