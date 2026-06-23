/** STT vocabulary for salon phone calls — keyterms + u3-rt-pro domain prompt. */

const MAX_KEYTERM_LEN = 50;
const DEFAULT_KEYTERM_CAP = 400;

const STATIC_SALON_KEYTERMS = [
  'appointment',
  'appointments',
  'hair appointment',
  'book an appointment',
  'book appointment',
  'booking',
  'haircut',
  'hair cut',
  'hair',
  'colour',
  'color',
  'balayage',
  'foils',
  'highlights',
  'root touch-up',
  'roots',
  'patch test',
  'consultation',
  'colour appointment',
  'blow-dry',
  'blowdry',
  'blow dry',
  'keratin',
  'trim',
  'cut',
  'gel manicure',
  'manicure',
  'pedicure',
  'shellac',
  'lashes',
  'lash lift',
  'brows',
  'wax',
  'facial',
  'nails',
  'Fresha',
  'Grafton',
  'Eircode',
  'Dublin',
];

export type BuildSttKeytermsInput = {
  orgName?: string | null;
  customPrompt?: string | null;
  extraTerms?: string[];
  cap?: number;
};

function normalizeKeyterm(term: string): string | null {
  const t = term.trim().replace(/\s+/g, ' ');
  if (t.length < 2 || t.length > MAX_KEYTERM_LEN) return null;
  return t;
}

/** Extract service names from compiled custom_prompt "Services menu:" bullets. */
export function parseServiceNamesFromCustomPrompt(customPrompt?: string | null): string[] {
  const text = String(customPrompt ?? '').trim();
  if (!text) return [];

  const menuIdx = text.indexOf('Services menu:');
  if (menuIdx < 0) return [];

  const afterMenu = text.slice(menuIdx);
  const stopMarkers = [
    '\nWhen someone asks how long',
    '\nIf a service is not listed',
    '\nAlso offered',
    '\nWe don',
    '\n## ',
  ];
  let end = afterMenu.length;
  for (const marker of stopMarkers) {
    const i = afterMenu.indexOf(marker);
    if (i > 0) end = Math.min(end, i);
  }
  const section = afterMenu.slice(0, end);
  const names: string[] = [];

  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('•')) continue;
    const body = trimmed.replace(/^•\s*/, '').trim();
    if (!body) continue;
    const name = body.split(/\s+—\s+/)[0]?.trim() ?? body;
    if (name.length >= 2) names.push(name);
  }

  return names;
}

export function buildSttKeyterms(input: BuildSttKeytermsInput): string[] {
  const cap = input.cap ?? DEFAULT_KEYTERM_CAP;
  const orgTokens =
    input.orgName
      ?.split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 1) ?? [];
  const catalogNames = parseServiceNamesFromCustomPrompt(input.customPrompt);
  const envExtra = input.extraTerms ?? [];

  const seen = new Set<string>();
  const out: string[] = [];

  const add = (raw: string) => {
    const term = normalizeKeyterm(raw);
    if (!term) return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };

  for (const term of STATIC_SALON_KEYTERMS) add(term);
  for (const term of envExtra) add(term);
  for (const term of orgTokens) add(term);
  for (const name of catalogNames) {
    add(name);
    for (const part of name.split(/\s+/)) {
      if (part.length > 2) add(part);
    }
  }

  return out.slice(0, cap);
}

export function buildSttDomainPrompt(orgName: string): string {
  const name = orgName.trim() || 'a hair and beauty salon';
  return (
    `Irish English phone calls to ${name}, a hair and beauty salon. ` +
    'Callers book appointments for haircuts, colour, balayage, highlights, root touch-up, ' +
    'blow-dry, gel manicure, pedicure, lashes, brows, waxing, and facials. ' +
    'Common phrases: hair appointment, book an appointment, haircut, book a haircut, ' +
    'root touch-up, gel manicure, lash lift, colour appointment.'
  );
}

export function isU3RtProSttModel(model: string): boolean {
  return model.toLowerCase().includes('u3-rt-pro');
}

export function isAssemblyAiSttModel(model: string): boolean {
  return model.toLowerCase().includes('assemblyai');
}

export type SttLatencyProfile = 'snappy' | 'balanced';

export type SttTurnSilenceTuning = {
  minTurnSilenceMs: number;
  maxTurnSilenceMs: number;
  eotConfidence: number;
};

export type EndpointingTuning = {
  minDelayMs: number;
  maxDelayMs: number;
};

export function resolveSttLatencyProfile(raw?: string | null): SttLatencyProfile {
  const value = (raw ?? process.env.LIVEKIT_STT_LATENCY_PROFILE ?? 'snappy').trim().toLowerCase();
  return value === 'balanced' ? 'balanced' : 'snappy';
}

export function sttTurnSilenceDefaults(profile: SttLatencyProfile): SttTurnSilenceTuning {
  if (profile === 'balanced') {
    return { minTurnSilenceMs: 300, maxTurnSilenceMs: 1400, eotConfidence: 0.4 };
  }
  return { minTurnSilenceMs: 200, maxTurnSilenceMs: 1000, eotConfidence: 0.35 };
}

/** LiveKit endpointing — zero extra delay when u3 neural STT owns turn end (snappy). */
export function endpointingDefaults(
  profile: SttLatencyProfile,
  useSttNeuralTurnDetection: boolean,
): EndpointingTuning {
  if (useSttNeuralTurnDetection) {
    if (profile === 'balanced') {
      return { minDelayMs: 80, maxDelayMs: 900 };
    }
    return { minDelayMs: 0, maxDelayMs: 0 };
  }
  return { minDelayMs: 80, maxDelayMs: 1200 };
}

export type AssemblyAiSttOptions = {
  keyterms_prompt?: string[];
  prompt?: string;
  min_turn_silence?: number;
  max_turn_silence?: number;
  end_of_turn_confidence_threshold?: number;
  format_turns?: boolean;
};

/** Build AssemblyAI modelOptions for LiveKit inference STT. */
export function buildAssemblyAiSttOptions(input: {
  model: string;
  keyterms: string[];
  domainPrompt: string;
  minTurnSilenceMs: number;
  maxTurnSilenceMs: number;
  eotConfidence: number;
}): AssemblyAiSttOptions {
  const base: AssemblyAiSttOptions = {
    min_turn_silence: input.minTurnSilenceMs,
    max_turn_silence: input.maxTurnSilenceMs,
    end_of_turn_confidence_threshold: input.eotConfidence,
    format_turns: true,
  };

  if (isU3RtProSttModel(input.model)) {
    return { ...base, prompt: input.domainPrompt };
  }

  if (input.keyterms.length > 0) {
    return { ...base, keyterms_prompt: input.keyterms };
  }

  return base;
}
