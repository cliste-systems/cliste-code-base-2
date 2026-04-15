import Fuse from 'fuse.js';

import type { SalonServiceRow } from './supabase.js';

export type ServiceMatchSuggestion = {
  id: string;
  name: string;
  /** 0–1, higher = better */
  confidence: number;
  source: 'fuse' | 'llm';
  reason?: string;
};

type LlmMatchJson = {
  matches?: { name: string; confidence?: number; reason?: string }[];
};

function fuseConfidence(fuseScore: number | undefined): number {
  if (fuseScore == null || Number.isNaN(fuseScore)) {
    return 0;
  }
  return Math.max(0, Math.min(1, 1 - fuseScore));
}

/** Fuzzy search against name + description — no manual keyword lists. */
function fuseRank(utterance: string, services: SalonServiceRow[]): ServiceMatchSuggestion[] {
  const trimmed = utterance.trim();
  if (!trimmed || services.length === 0) {
    return [];
  }

  const docs = services.map((s) => ({
    id: s.id,
    name: s.name,
    haystack: [s.name, typeof s.description === 'string' ? s.description : '']
      .filter(Boolean)
      .join(' '),
  }));

  const fuse = new Fuse(docs, {
    keys: ['haystack', 'name'],
    includeScore: true,
    threshold: 0.52,
    ignoreLocation: true,
    minMatchCharLength: 2,
    distance: 80,
  });

  const results = fuse.search(trimmed, { limit: 8 });
  return results.map((r) => ({
    id: r.item.id,
    name: r.item.name,
    confidence: fuseConfidence(r.score),
    source: 'fuse' as const,
  }));
}

function menuNameSet(services: SalonServiceRow[]): Map<string, SalonServiceRow> {
  const m = new Map<string, SalonServiceRow>();
  for (const s of services) {
    m.set(s.name.trim().toLowerCase(), s);
  }
  return m;
}

/**
 * When fuzzy match is weak, map nonsense STT to menu items using a small LLM (optional).
 * Set OPENAI_API_KEY (or SERVICE_INTENT_OPENAI_KEY) on the worker.
 */
async function llmRank(
  utterance: string,
  services: SalonServiceRow[],
): Promise<ServiceMatchSuggestion[] | null> {
  const key =
    process.env.SERVICE_INTENT_OPENAI_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!key || services.length === 0) {
    return null;
  }

  const model =
    process.env.SERVICE_INTENT_MODEL?.trim() || 'gpt-4o-mini';
  const menu = services.map((s) => ({
    name: s.name,
    blurb: typeof s.description === 'string' ? s.description.slice(0, 280) : '',
  }));

  const body = {
    model,
    temperature: 0.15,
    max_tokens: 220,
    response_format: { type: 'json_object' as const },
    messages: [
      {
        role: 'system' as const,
        content:
          'You map messy phone transcripts to salon service names. Transcripts are often wrong (wrong words, homophones). ' +
          'Return JSON only: {"matches":[{"name":"exact name from menu","confidence":0.0-1.0,"reason":"brief"}]}. ' +
          'Only use names from the provided menu. If nothing fits, return {"matches":[]}.',
      },
      {
        role: 'user' as const,
        content: JSON.stringify({ transcript: utterance, menu }),
      },
    ],
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error('service_menu_match llmRank HTTP', res.status, await res.text().catch(() => ''));
    return null;
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    return null;
  }

  let parsed: LlmMatchJson;
  try {
    parsed = JSON.parse(raw) as LlmMatchJson;
  } catch {
    return null;
  }

  const byName = menuNameSet(services);
  const out: ServiceMatchSuggestion[] = [];
  for (const m of parsed.matches ?? []) {
    const n = typeof m.name === 'string' ? m.name.trim() : '';
    if (!n) continue;
    const row = byName.get(n.toLowerCase());
    if (!row) continue;
    const c =
      typeof m.confidence === 'number' && m.confidence >= 0 && m.confidence <= 1
        ? m.confidence
        : 0.6;
    const item: ServiceMatchSuggestion = {
      id: row.id,
      name: row.name,
      confidence: c,
      source: 'llm',
    };
    if (typeof m.reason === 'string' && m.reason.trim()) {
      item.reason = m.reason.trim();
    }
    out.push(item);
  }
  return out;
}

const FUSE_MIN_CONFIDENCE = 0.38;

/**
 * Combines fuzzy matching on the live menu with an optional LLM pass when STT is garbage.
 * Does not require maintaining keyword lists — the menu is the vocabulary.
 */
export async function matchServicesFromUtterance(
  utterance: string,
  services: SalonServiceRow[],
): Promise<{
  suggestions: ServiceMatchSuggestion[];
  usedLlm: boolean;
  hint: string;
}> {
  const fuseHits = fuseRank(utterance, services);
  const topFuse = fuseHits[0];

  if (topFuse !== undefined && topFuse.confidence >= FUSE_MIN_CONFIDENCE) {
    return {
      suggestions: fuseHits.slice(0, 5),
      usedLlm: false,
      hint:
        'Good fuzzy match. Confirm using the MENU name only (e.g. “fade”)—do not repeat garbled STT words like “feed” to the caller.',
    };
  }

  const llmHits = await llmRank(utterance, services);
  if (llmHits && llmHits.length > 0) {
    llmHits.sort((a, b) => b.confidence - a.confidence);
    return {
      suggestions: llmHits.slice(0, 5),
      usedLlm: true,
      hint:
        'Intent model suggested matches. Confirm with the menu spelling only—never quote nonsense STT back aloud.',
    };
  }

  if (fuseHits.length > 0) {
    return {
      suggestions: fuseHits.slice(0, 5),
      usedLlm: false,
      hint:
        'Weak match—ask them to describe the service in other words or pick from the menu. Do not quote messy STT back.',
    };
  }

  return {
    suggestions: [],
    usedLlm: false,
    hint:
      'No menu match—ask what kind of appointment they need, or read similar services from the menu.',
  };
}
