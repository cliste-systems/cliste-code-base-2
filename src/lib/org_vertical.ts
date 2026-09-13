/** Lightweight vertical hints for the voice worker — retail-first until other verticals ship. */

export type OrgVertical = 'retail' | 'generic';

export function isRetailNiche(niche: string | null | undefined): boolean {
  const n = niche?.trim().toLowerCase() ?? '';
  return n === 'retail' || n.includes('retail') || n.includes('grocery') || n.includes('supermarket');
}

export function orgVerticalLabel(input: {
  niche?: string | null;
  businessType?: string | null;
}): OrgVertical {
  if (isRetailNiche(input.niche) || isRetailNiche(input.businessType)) return 'retail';
  return 'generic';
}
