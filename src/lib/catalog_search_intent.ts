export type CatalogSearchIntent = 'offer' | 'price' | 'stock';

export function inferCatalogSearchIntent(query: string): CatalogSearchIntent {
  const q = query.toLowerCase();
  if (
    /\bon offer\b|\bthis week\b|\bspecial\b|\bpromo|\bpromotion|\bdeal\b|\breduced\b|\bany offers\b|\bis it on\b|\bare they on\b|\boffers?\s+this\b/i.test(
      q,
    )
  ) {
    return 'offer';
  }
  if (
    /\bhow much\b|\bprice\b|\bcost\b|\bwhat'?s the price\b|\bhow much is\b|\bwhat is the price\b/i.test(
      q,
    )
  ) {
    return 'price';
  }
  return 'stock';
}

export function resolveCatalogSearchIntent(input: {
  query: string;
  explicitIntent?: CatalogSearchIntent;
  callerAskedAboutOffers?: boolean;
}): CatalogSearchIntent | undefined {
  if (input.explicitIntent) return input.explicitIntent;
  const fromQuery = inferCatalogSearchIntent(input.query);
  if (fromQuery !== 'stock') return fromQuery;
  if (input.callerAskedAboutOffers) return 'offer';
  return undefined;
}

/** Caller wants a rundown of synced offers, not one specific product. */
export function inferWeeklyOffersListIntent(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true;
  if (
    /\bweekly offers\b|\bwhat offers\b|\bwhat'?s on offer\b|\bwhats on offer\b|\bbest offer|\blist offers\b|\blist (?:five|5|\d+)\b|\bany offers\b|\boffers (?:this week|do you have|you have|on)\b|\bsurprise me\b|\bhighlights\b|\btell me (?:the|your) offers\b|\bapart from meat\b|\bnot meat\b|\bgrocery offers\b|\bwhat (?:meat )?offers\b|\b(?:meat|butcher) offers\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  const tokens = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (tokens.length === 0 && /\boffer/i.test(trimmed)) return true;
  if (
    tokens.length === 1 &&
    /^(meat|butcher|deli|offers?|promos?|grocery)$/i.test(tokens[0] ?? '')
  ) {
    return true;
  }
  if (tokens.length >= 2 && inferWeeklyOffersBrowseCategories(trimmed).length >= 2) {
    return true;
  }
  return false;
}

export function inferWeeklyOffersBrowseCategories(query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  const tokens = trimmed
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const categoryHints = new Set([
    'milk',
    'bread',
    'crisps',
    'chocolate',
    'fruit',
    'yogurt',
    'cheese',
    'butter',
    'tea',
    'coffee',
    'biscuits',
    'sweets',
    'confectionery',
    'drinks',
    'household',
    'frozen',
  ]);
  const fromTokens = tokens.filter((token) => categoryHints.has(token));
  if (fromTokens.length >= 2) return fromTokens.slice(0, 5);
  if (/confectionery|sweets|candy/.test(trimmed)) return ['chocolate', 'sweets'];
  if (/\bapart from meat\b|\bnot meat\b|\bgrocery offers\b|\bnon[- ]meat\b/i.test(trimmed)) {
    return ['chocolate', 'crisps', 'yogurt', 'bread', 'fruit'];
  }
  if (/\blist\b|\bfive\b|\b5\b|weekly offers|best deal|sample|highlights/i.test(trimmed)) {
    return ['chocolate', 'crisps', 'yogurt', 'bread', 'fruit'];
  }
  return [];
}

export function trackCallerCatalogSearchIntent(
  text: string,
  flags: { callerAskedAboutOffers?: boolean },
): void {
  const t = text.toLowerCase();
  if (
    /\b(on offer|this week|any offers?|special|promotion|promo|deal|reduced|is there an offer|are there offers|offer on|weekly offers|what offers|what meat offers|meat offers|list offers|apart from meat)\b/i.test(
      t,
    )
  ) {
    flags.callerAskedAboutOffers = true;
    return;
  }
  if (
    /\bhow much\b|\bwhat'?s the price\b|\bhow much is\b|\bprice of\b|\bwhat is the price\b/i.test(
      t,
    )
  ) {
    flags.callerAskedAboutOffers = false;
    return;
  }
  if (
    /\b(do you sell|do you stock|do you carry|have you got)\b/i.test(t) &&
    !/\boffer\b/i.test(t)
  ) {
    flags.callerAskedAboutOffers = false;
  }
}
