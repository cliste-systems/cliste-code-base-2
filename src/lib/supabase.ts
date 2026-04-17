import { type SupabaseClient, createClient } from '@supabase/supabase-js';

import { cached } from './cache.js';

/** Read-mostly salon config / catalogue cache window. Dashboard edits surface within this. */
const SALON_CACHE_TTL_MS = Number.parseInt(
  process.env.CLISTE_SALON_CACHE_TTL_MS ?? '60000',
  10,
);

let client: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  if (!client) {
    client = createClient(supabaseUrl, supabaseServiceKey);
  }
  return client;
}

export function getSupabaseClient(): SupabaseClient {
  return getSupabase();
}

export type SalonConfig = {
  id: string;
  name: string;
  slug: string | null;
  tier: string;
  business_hours: unknown;
  custom_prompt: string | null;
  greeting: string | null;
  fresha_url: string | null;
  phone_number: string | null;
};

export type SalonServiceRow = {
  id: string;
  name: string;
  description: string | null;
  price: unknown;
  duration_minutes: number | null;
};

const orgSelect =
  'id, name, slug, tier, business_hours, custom_prompt, greeting, fresha_url, phone_number';

function phoneLookupVariants(phone: string): string[] {
  const t = phone.trim();
  const variants = new Set<string>([t]);
  const digits = t.replace(/\D/g, '');

  if (digits.length === 10) {
    variants.add(`+1${digits}`);
    variants.add(`1${digits}`);
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    variants.add(`+${digits}`);
  }

  if (digits.startsWith('353') && digits.length >= 11) {
    variants.add(`+${digits}`);
    variants.add(digits);
  }
  if (digits.startsWith('0') && digits.length >= 10 && digits.length <= 11) {
    const national = digits.slice(1);
    variants.add(`+353${national}`);
    variants.add(`353${national}`);
  }

  return [...variants];
}

export async function getSalonConfigBySlug(slug: string): Promise<SalonConfig | null> {
  const s = slug.trim();
  if (!s) {
    return null;
  }
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('organizations')
    .select(orgSelect)
    .eq('slug', s)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (data) {
    return data as SalonConfig;
  }

  const { data: ci, error: e2 } = await supabase
    .from('organizations')
    .select(orgSelect)
    .ilike('slug', s)
    .maybeSingle();

  if (e2) {
    throw e2;
  }
  return ci as SalonConfig | null;
}

export async function getSalonForCall(input: { slug?: string; phone?: string }): Promise<SalonConfig | null> {
  const slug = input.slug?.trim();
  const phone = input.phone?.trim();
  // Cache key includes both inputs so a slug-vs-phone mismatch can't return
  // the wrong salon. Salon rows themselves contain no per-call PII.
  const cacheKey = `salon:${slug ?? ''}:${phone ?? ''}`;
  return cached(cacheKey, SALON_CACHE_TTL_MS, async () => {
    if (slug) {
      const bySlug = await getSalonConfigBySlug(slug);
      if (bySlug) {
        return bySlug;
      }
    }
    if (!phone) {
      return null;
    }
    const supabase = getSupabase();
    for (const variant of phoneLookupVariants(phone)) {
      const { data, error } = await supabase
        .from('organizations')
        .select(orgSelect)
        .eq('phone_number', variant)
        .maybeSingle();

      if (error) {
        throw error;
      }
      if (data) {
        return data as SalonConfig;
      }
    }
    return null;
  });
}

export async function getSalonServices(organizationId: string): Promise<SalonServiceRow[]> {
  return cached(`services:${organizationId}`, SALON_CACHE_TTL_MS, async () => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('services')
      .select('id, name, description, price, duration_minutes')
      .eq('organization_id', organizationId);

    if (error) {
      throw error;
    }
    return (data ?? []) as SalonServiceRow[];
  });
}
