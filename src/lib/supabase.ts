import { createRequire } from 'node:module';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';

import { cached } from './cache.js';

const require = createRequire(import.meta.url);

/** Node 20 has no native WebSocket; Supabase realtime-js requires one at init (REST-only here). */
function ensureNodeWebSocket(): void {
  if (typeof globalThis.WebSocket !== 'undefined') return;
  try {
    globalThis.WebSocket = require('ws');
  } catch {
    class StubWebSocket {
      constructor() {}
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    }
    globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;
  }
}

const ORG_CACHE_TTL_MS = Number.parseInt(
  process.env.CLISTE_ORG_CACHE_TTL_MS ??
    process.env.CLISTE_SALON_CACHE_TTL_MS ??
    '30000',
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
    ensureNodeWebSocket();
    client = createClient(supabaseUrl, supabaseServiceKey);
  }
  return client;
}

export function getSupabaseClient(): SupabaseClient {
  return getSupabase();
}

/** Full org slice for inbound Cara calls — aligned with code-base-1 compile contract. */
export type OrgCallConfig = {
  id: string;
  account_id: string | null;
  name: string;
  slug: string | null;
  niche: string | null;
  tier: string;
  status: string | null;
  is_active: boolean;
  account_status: string | null;
  business_hours: unknown;
  custom_prompt: string | null;
  greeting: string | null;
  assistant_display_name: string | null;
  agent_voice_id: string | null;
  agent_business_type: string | null;
  agent_opening_hours: string | null;
  routing_links: unknown;
  fallback_number: string | null;
  call_routing_mode: string | null;
  phone_number: string | null;
  plan_tier: string | null;
  billing_period_start: string | null;
  block_anonymous_callers: boolean;
};

export type BusinessFileRow = {
  id: string;
  file_name: string;
  mime_type: string | null;
  storage_path: string;
  send_enabled: boolean;
};

const ORG_SELECT = `
  id,
  account_id,
  name,
  slug,
  niche,
  tier,
  status,
  is_active,
  business_hours,
  custom_prompt,
  greeting,
  assistant_display_name,
  agent_voice_id,
  agent_business_type,
  agent_opening_hours,
  routing_links,
  fallback_number,
  call_routing_mode,
  phone_number,
  plan_tier,
  billing_period_start,
  block_anonymous_callers,
  accounts ( status )
`;

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

function mapOrgRow(data: Record<string, unknown>): OrgCallConfig {
  const accounts = data.accounts as { status?: string } | { status?: string }[] | null;
  const accountStatus = Array.isArray(accounts)
    ? accounts[0]?.status ?? null
    : accounts?.status ?? null;

  return {
    id: String(data.id ?? ''),
    account_id: data.account_id ? String(data.account_id) : null,
    name: String(data.name ?? ''),
    slug: data.slug ? String(data.slug) : null,
    niche: data.niche ? String(data.niche) : null,
    tier: String(data.tier ?? ''),
    status: data.status ? String(data.status) : null,
    is_active: data.is_active !== false,
    account_status: accountStatus,
    business_hours: data.business_hours,
    custom_prompt: data.custom_prompt ? String(data.custom_prompt) : null,
    greeting: data.greeting ? String(data.greeting) : null,
    assistant_display_name: data.assistant_display_name
      ? String(data.assistant_display_name)
      : null,
    agent_voice_id: data.agent_voice_id ? String(data.agent_voice_id) : null,
    agent_business_type: data.agent_business_type
      ? String(data.agent_business_type)
      : null,
    agent_opening_hours: data.agent_opening_hours
      ? String(data.agent_opening_hours)
      : null,
    routing_links: data.routing_links,
    fallback_number: data.fallback_number ? String(data.fallback_number) : null,
    call_routing_mode: data.call_routing_mode
      ? String(data.call_routing_mode)
      : null,
    phone_number: data.phone_number ? String(data.phone_number) : null,
    plan_tier: data.plan_tier ? String(data.plan_tier) : null,
    billing_period_start: data.billing_period_start
      ? String(data.billing_period_start)
      : null,
    block_anonymous_callers: data.block_anonymous_callers === true,
  };
}

function slugMatches(org: OrgCallConfig, slug: string): boolean {
  const orgSlug = org.slug?.trim().toLowerCase();
  const want = slug.trim().toLowerCase();
  return Boolean(orgSlug && want && orgSlug === want);
}

async function fetchOrgBySlug(slug: string): Promise<OrgCallConfig | null> {
  const s = slug.trim();
  if (!s) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('organizations')
    .select(ORG_SELECT)
    .eq('slug', s)
    .maybeSingle();

  if (error) throw error;
  if (data) return mapOrgRow(data as Record<string, unknown>);

  const { data: ci, error: e2 } = await supabase
    .from('organizations')
    .select(ORG_SELECT)
    .ilike('slug', s)
    .maybeSingle();

  if (e2) throw e2;
  return ci ? mapOrgRow(ci as Record<string, unknown>) : null;
}

async function fetchOrgByPhoneOnOrg(phone: string): Promise<OrgCallConfig | null> {
  const supabase = getSupabase();
  for (const variant of phoneLookupVariants(phone)) {
    const { data, error } = await supabase
      .from('organizations')
      .select(ORG_SELECT)
      .eq('phone_number', variant)
      .maybeSingle();

    if (error) throw error;
    if (data) return mapOrgRow(data as Record<string, unknown>);
  }
  return null;
}

async function fetchOrgByPhonePool(phone: string): Promise<OrgCallConfig | null> {
  const supabase = getSupabase();
  for (const variant of phoneLookupVariants(phone)) {
    const { data: phoneRow, error: phoneErr } = await supabase
      .from('phone_numbers')
      .select('organization_id')
      .eq('e164', variant)
      .eq('status', 'assigned')
      .maybeSingle();

    if (phoneErr) throw phoneErr;
    if (!phoneRow?.organization_id) continue;

    const { data, error } = await supabase
      .from('organizations')
      .select(ORG_SELECT)
      .eq('id', phoneRow.organization_id)
      .maybeSingle();

    if (error) throw error;
    if (data) return mapOrgRow(data as Record<string, unknown>);
  }
  return null;
}

async function resolveOrgUncached(input: {
  slug?: string;
  phone?: string;
}): Promise<OrgCallConfig | null> {
  const slug = input.slug?.trim();
  const phone = input.phone?.trim();

  if (phone) {
    const byPool = await fetchOrgByPhonePool(phone);
    if (byPool) {
      if (slug && !slugMatches(byPool, slug)) {
        console.warn('[supabase] slug/phone mismatch — using phone_numbers org', {
          slug,
          orgSlug: byPool.slug,
        });
      }
      return byPool;
    }

    const byOrgPhone = await fetchOrgByPhoneOnOrg(phone);
    if (byOrgPhone) {
      if (slug && !slugMatches(byOrgPhone, slug)) {
        console.warn('[supabase] slug/phone mismatch — using organizations.phone_number org', {
          slug,
          orgSlug: byOrgPhone.slug,
        });
      }
      return byOrgPhone;
    }
  }

  if (slug) {
    return fetchOrgBySlug(slug);
  }

  return null;
}

/** Resolve org by dialed number first (`phone_numbers.e164`), then slug for dev dispatch. */
export async function getOrgForCall(input: {
  slug?: string;
  phone?: string;
}): Promise<OrgCallConfig | null> {
  const slug = input.slug?.trim();
  const phone = input.phone?.trim();
  const cacheKey = `org:${slug ?? ''}:${phone ?? ''}`;
  return cached(cacheKey, ORG_CACHE_TTL_MS, () =>
    resolveOrgUncached({
      ...(slug ? { slug } : {}),
      ...(phone ? { phone } : {}),
    }),
  );
}

export async function getSendableBusinessFiles(
  organizationId: string,
): Promise<BusinessFileRow[]> {
  return cached(`bizfiles:${organizationId}`, ORG_CACHE_TTL_MS, async () => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('business_files')
      .select('id, file_name, mime_type, storage_path, send_enabled')
      .eq('organization_id', organizationId)
      .eq('send_enabled', true);

    if (error) throw error;
    return (data ?? []) as BusinessFileRow[];
  });
}

export async function createBusinessFileSignedUrl(
  storagePath: string,
  expiresInSeconds = 3600,
): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from('business-files')
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export function resolveOrgTimeZone(org: OrgCallConfig): string {
  const raw = org.business_hours;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const tz = (raw as Record<string, unknown>).timezone;
    if (typeof tz === 'string' && tz.trim()) {
      return tz.trim();
    }
  }
  return process.env.ORG_TIMEZONE?.trim() || process.env.SALON_TIMEZONE?.trim() || 'Europe/Dublin';
}

export function resolveOrgVoiceId(org: OrgCallConfig): string | null {
  const id = org.agent_voice_id?.trim();
  if (id) return id;
  const envId = process.env.ELEVEN_VOICE_ID?.trim();
  return envId || null;
}
