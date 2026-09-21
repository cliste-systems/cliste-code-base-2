export type RetailProductFulfilment = 'counter' | 'prepack';

const QUERY_NOISE = new Set([
  'a','an','the','and','or','for','to','of','in','on','at','is','it','are','do','you','we','i',
  'any','some','there','this','that','week','today','offer','offers','offered','special','specials',
  'deal','deals','promo','promos','promotion','promotions','price','prices','stock','please','just',
  'wondering','have','got','with','from','now','currently','sale',
]);

function normalizeToken(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.length > 4 && normalized.endsWith('s')) return normalized.slice(0, -1);
  return normalized;
}

function boundedEditDistance(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = current[0]!;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[b.length]!;
}

function tokenSimilarity(queryToken: string, productWord: string): number {
  const query = normalizeToken(queryToken);
  const word = normalizeToken(productWord);
  if (!query || !word) return 0;
  if (query === word) return 1;
  if (query.length >= 4 && word.length >= 4 && (word.includes(query) || query.includes(word))) {
    return 0.9;
  }
  if (query.length < 5 || word.length < 5) return 0;
  const maxDistance = Math.max(query.length, word.length) >= 9 ? 2 : 1;
  const distance = boundedEditDistance(query, word, maxDistance);
  if (distance > maxDistance) return 0;
  return 1 - distance / Math.max(query.length, word.length);
}

export function productQueryTokens(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !QUERY_NOISE.has(token)),
  )];
}

export function inferExplicitProductFulfilment(
  query: string,
): RetailProductFulfilment | undefined {
  const q = query.toLowerCase();
  if (
    /pre\s*-?\s*pack|packaged|meat aisle|fish aisle|chilled aisle|chilled pack|in the aisle|on the shelf|shelf pack/.test(q)
  ) {
    return 'prepack';
  }
  if (
    /(?:butcher|meat|fish|deli|seafood)\s+counter|counter\s+(?:ham|meat|fish|salmon|steak|prawns?)|the counter|fresh sliced|per kilo|per kg|by weight|loose|priced per/.test(q)
  ) {
    return 'counter';
  }
  if (/\bcounter\b/.test(q) && !/pre\s*-?\s*pack|packaged/.test(q)) return 'counter';
  return undefined;
}

export function buildProductFallbackQueries(query: string): string[] {
  const ordered = productQueryTokens(query)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  const fallbacks: string[] = [];
  for (const token of ordered) {
    if (!fallbacks.includes(token)) fallbacks.push(token);
    const normalized = normalizeToken(token);
    if (normalized && normalized !== token && !fallbacks.includes(normalized)) {
      fallbacks.push(normalized);
    }
  }
  return fallbacks;
}

export function fuzzyProductMatchScore(query: string, productName: string): number {
  const queryTokens = productQueryTokens(query);
  if (queryTokens.length === 0) return 0;
  const productWords = productName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (productWords.length === 0) return 0;

  let total = 0;
  for (const token of queryTokens) {
    let best = 0;
    for (const word of productWords) {
      best = Math.max(best, tokenSimilarity(token, word));
      if (best === 1) break;
    }
    total += best;
  }
  return total / queryTokens.length;
}

export function pickConfidentFuzzyProductMatch<T extends { product_name: string }>(
  query: string,
  matches: T[],
): T | null {
  if (matches.length === 0) return null;
  const ranked = matches
    .map((match) => ({ match, score: fuzzyProductMatchScore(query, match.product_name) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top || top.score < 0.78) return null;
  const second = ranked[1];
  if (second && top.score - second.score < 0.18) return null;
  return top.match;
}
