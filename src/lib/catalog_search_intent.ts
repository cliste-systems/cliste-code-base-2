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

export function trackCallerCatalogSearchIntent(
  text: string,
  flags: { callerAskedAboutOffers?: boolean },
): void {
  const t = text.toLowerCase();
  if (
    /\b(on offer|this week|any offers?|special|promotion|promo|deal|reduced|is there an offer|are there offers|offer on)\b/i.test(
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
