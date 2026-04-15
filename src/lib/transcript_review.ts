import type { SalonServiceRow } from './supabase.js';

/**
 * Common STT mishearings → canonical menu spelling (key = lowercase service name).
 * Only applied when that service exists on the menu.
 */
const SERVICE_CONFUSIONS: Record<string, string[]> = {
  fade: ['feed', 'feet', 'fate', 'fead', 'feid'],
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Fix obvious word-level STT errors using the salon service list. */
export function applyDeterministicSalonTranscript(
  verbatim: string,
  services: Pick<SalonServiceRow, 'name'>[],
): string {
  let out = verbatim;
  const names = services
    .map((s) => (typeof s.name === 'string' ? s.name.trim() : ''))
    .filter(Boolean);

  for (const canonical of names) {
    const key = canonical.toLowerCase();
    const confusions = SERVICE_CONFUSIONS[key];
    if (!confusions?.length) {
      continue;
    }
    for (const wrong of confusions) {
      if (wrong.toLowerCase() === key) {
        continue;
      }
      const re = new RegExp(`\\b${escapeRegExp(wrong)}\\b`, 'gi');
      out = out.replace(re, canonical);
    }
  }
  return out;
}
