import { getSupabaseClient } from './supabase.js';

const EURO_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const CENT_WORDS: Record<string, number> = {
  ten: 10,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const SMALL_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;

const TENS_WORDS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const;

export function inferRewardsPricePoint(query: string): number | null {
  const q = query.toLowerCase();
  if (!/\b(?:real\s+rewards?|rewards?)(?:\s+price)?\b/i.test(q)) return null;

  const numeric = q.match(/(?:€\s*)?(\d{1,3}(?:[.,]\d{1,2})?)/);
  if (numeric) {
    const amount = Number(numeric[1]!.replace(',', '.'));
    if (Number.isFinite(amount) && amount > 0) {
      return Math.round(amount * 100) / 100;
    }
  }

  const euroWords = Object.keys(EURO_WORDS).join('|');
  const centWords = Object.keys(CENT_WORDS).join('|');
  const spoken = q.match(
    new RegExp(`\\b(${euroWords})\\s+(?:euro(?:s)?\\s+)?(${centWords})\\b`, 'i'),
  );
  if (!spoken) return null;

  const euros = EURO_WORDS[spoken[1]!.toLowerCase()];
  const cents = CENT_WORDS[spoken[2]!.toLowerCase()];
  if (euros == null || cents == null) return null;
  return euros + cents / 100;
}

function spokenInteger(value: number): string {
  const n = Math.round(value);
  if (n >= 0 && n < 20) return SMALL_WORDS[n] ?? String(n);
  if (n >= 20 && n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0
      ? TENS_WORDS[tens] ?? String(n)
      : `${TENS_WORDS[tens]} ${SMALL_WORDS[ones]}`;
  }
  return String(n);
}

export function formatSpokenRewardsPrice(amountEur: number): string {
  const normalized = Math.round(amountEur * 100) / 100;
  const euros = Math.floor(normalized);
  const cents = Math.round((normalized - euros) * 100);
  if (cents === 0) return `${spokenInteger(euros)} euro`;
  if (euros === 0) return `${spokenInteger(cents)} cents`;
  return `${spokenInteger(euros)} euro ${spokenInteger(cents)}`;
}

export type RewardsPricePointRow = {
  product_name: string;
  department: string | null;
  sku: string | null;
  current_price_eur: number | string;
  was_price_eur: number | string | null;
  discount_label: string | null;
  service_area: string | null;
  fulfilment: string | null;
  is_alcohol: boolean | null;
};

export type DirectRewardsPriceMatch = {
  product_name: string;
  department: string;
  sku: string | null;
  score: number;
  quote_text: string;
  is_on_offer: true;
  is_alcohol: boolean;
  service_area: string | null;
  fulfilment: string | null;
};

export function buildRewardsPricePointMatches(
  rows: RewardsPricePointRow[],
  amountEur: number,
  limit = 5,
): DirectRewardsPriceMatch[] {
  const seen = new Set<string>();
  return rows
    .filter((row) => /\brewards?\s+price\b|\breal\s+rewards?\b/i.test(String(row.discount_label ?? '')))
    .filter((row) => Math.abs(Number(row.current_price_eur) - amountEur) <= 0.01)
    .sort(
      (a, b) =>
        Number(a.is_alcohol === true) - Number(b.is_alcohol === true) ||
        a.product_name.localeCompare(b.product_name),
    )
    .filter((row) => {
      const key = `${row.sku ?? ''}:${row.product_name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((row, index) => {
      const current = Number(row.current_price_eur);
      const was = row.was_price_eur == null ? null : Number(row.was_price_eur);
      const price = formatSpokenRewardsPrice(current);
      const usual =
        was != null && Number.isFinite(was) && was > current
          ? ` Usually ${formatSpokenRewardsPrice(was)}.`
          : '';
      return {
        product_name: row.product_name,
        department: row.department ?? 'Grocery',
        sku: row.sku,
        score: 1 - index * 0.01,
        quote_text: `${row.product_name}. Rewards Price ${price}.${usual}`,
        is_on_offer: true,
        is_alcohol: row.is_alcohol === true,
        service_area: row.service_area,
        fulfilment: row.fulfilment,
      };
    });
}

function dublinDate(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export async function searchRewardsPricePointOffersDirect(input: {
  amountEur: number;
  serviceArea?: string;
  limit?: number;
}): Promise<DirectRewardsPriceMatch[]> {
  const today = dublinDate();
  const supabase = getSupabaseClient();
  let query = supabase
    .from('retail_weekly_offers')
    .select(
      'product_name,department,sku,current_price_eur,was_price_eur,discount_label,service_area,fulfilment,is_alcohol',
    )
    .eq('retail_banner', 'supervalu')
    .eq('is_national', true)
    .eq('current_price_eur', input.amountEur)
    .lte('offer_week_start', today)
    .gte('offer_week_end', today)
    .ilike('discount_label', '%Reward%')
    .order('product_name', { ascending: true })
    .limit(50);

  if (input.serviceArea) {
    query = query.eq('service_area', input.serviceArea);
  }

  const { data, error } = await query;
  if (error) throw error;

  return buildRewardsPricePointMatches(
    (data ?? []) as RewardsPricePointRow[],
    input.amountEur,
    input.limit ?? 5,
  );
}
