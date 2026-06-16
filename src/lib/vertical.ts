const SALON_BEAUTY_NICHES = new Set(['hair_salon', 'barber', 'beauty']);

/** Salon & Beauty vertical — the only tailored product path. */
export function isSalonBeautyNiche(niche: string | null | undefined): boolean {
  const n = (niche ?? '').trim().toLowerCase();
  return SALON_BEAUTY_NICHES.has(n);
}
