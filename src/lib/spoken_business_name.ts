const RETAIL_BANNER =
  /\b(SuperValu|Super Valu|Centra|Lidl|Aldi|Tesco|Dunnes(?: Stores)?|Mace|Spar|Marks?\s*Spencer)\b/i;

export type SpokenBusinessNameInput = {
  name: string;
  greeting?: string | null;
  agentBaseTown?: string | null;
};

/** Name locals would say on the phone — trade name, not "Owner's Banner Town". */
export function resolveSpokenBusinessName(input: SpokenBusinessNameInput): string {
  const fallback = input.name.trim();
  let spoken = parseBusinessNameFromGreeting(input.greeting) || fallback;
  if (!spoken) return 'us';

  spoken = stripCountySuffix(spoken);
  spoken = stripSuffixToken(spoken, input.agentBaseTown);
  spoken = stripTrailingTownAfterRetailBanner(spoken);

  return spoken.trim() || fallback || 'us';
}

function parseBusinessNameFromGreeting(greeting?: string | null): string | null {
  const text = greeting?.trim();
  if (!text) return null;

  const throughTo = text.match(/\bthrough to\s+(.+?)(?:\s*[-—–]\s*|\.\s|$)/i);
  if (throughTo?.[1]?.trim()) return throughTo[1].trim();

  const thanksFor = text.match(/^thanks for calling\s+(.+?)(?:[.!]|$)/i);
  if (thanksFor?.[1]?.trim()) return thanksFor[1].trim();

  return null;
}

function stripCountySuffix(name: string): string {
  return name.replace(/,?\s*Co\.?\s+[A-Za-z]+$/i, '').trim();
}

function stripSuffixToken(name: string, token?: string | null): string {
  const t = token?.trim();
  if (!t) return name;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return name.replace(new RegExp(`\\s+${escaped}$`, 'i'), '').trim();
}

/** Murphy's SuperValu Killarney → Murphy's SuperValu on the phone. */
function stripTrailingTownAfterRetailBanner(name: string): string {
  if (!RETAIL_BANNER.test(name)) return name;
  const match = name.match(
    /^(.+?\b(?:SuperValu|Super Valu|Centra|Lidl|Aldi|Tesco|Dunnes(?: Stores)?|Mace|Spar|Marks?\s*Spencer))\s+[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?$/i,
  );
  return match?.[1]?.trim() || name;
}
