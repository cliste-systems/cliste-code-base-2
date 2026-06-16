/**
 * Tolerant parse of organizations.routing_links — mirrors code-base-1 shape.
 */

export type RoutingTargetType =
  | 'link'
  | 'form'
  | 'callback'
  | 'email'
  | 'phone'
  | 'whatsapp'
  | 'note';

export type RoutingLink = {
  id: string;
  presetId?: string | null;
  label: string;
  intent: string;
  targetType: RoutingTargetType;
  url: string;
  businessFileId?: string | null;
  active: boolean;
  keywords?: string | null;
  description?: string | null;
};

const ROUTING_TARGET_VALUES = new Set<string>([
  'link',
  'form',
  'callback',
  'email',
  'phone',
  'whatsapp',
  'note',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isRoutingTargetType(v: unknown): v is RoutingTargetType {
  return typeof v === 'string' && ROUTING_TARGET_VALUES.has(v);
}

export function parseRoutingLinks(raw: unknown): RoutingLink[] {
  if (!Array.isArray(raw)) return [];
  const out: RoutingLink[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const label = typeof entry.label === 'string' ? entry.label : '';
    const intent = typeof entry.intent === 'string' ? entry.intent : '';
    const url = typeof entry.url === 'string' ? entry.url : '';
    let targetType: RoutingTargetType = 'link';
    if (isRoutingTargetType(entry.targetType)) {
      targetType = entry.targetType;
    }
    const active = entry.active !== false;
    const businessFileId =
      typeof entry.businessFileId === 'string' && entry.businessFileId.trim()
        ? entry.businessFileId.trim()
        : null;
    const presetId =
      typeof entry.presetId === 'string' && entry.presetId.trim()
        ? entry.presetId.trim()
        : null;
    const id =
      typeof entry.id === 'string' && entry.id.trim()
        ? entry.id
        : presetId
          ? `preset_${presetId}`
          : `route_${out.length}`;
    if (!label && !intent && !url && !businessFileId) continue;
    out.push({
      id,
      presetId,
      label: label.trim(),
      intent: intent.trim(),
      targetType,
      url: url.trim(),
      businessFileId,
      active,
      keywords:
        typeof entry.keywords === 'string' ? entry.keywords.trim() : null,
      description:
        typeof entry.description === 'string' ? entry.description.trim() : null,
    });
  }
  return out;
}

export function isFallbackRoute(link: RoutingLink): boolean {
  const key = (link.intent || link.label).trim().toLowerCase();
  return key === 'anything else' || key === 'fallback';
}

export function routeTrigger(link: RoutingLink): string {
  return (link.label || link.intent || link.keywords || '').trim();
}

export function activeRoutes(links: RoutingLink[]): RoutingLink[] {
  return links.filter((r) => r.active && !isFallbackRoute(r));
}

export function fallbackRoute(links: RoutingLink[]): RoutingLink | null {
  return links.find((r) => r.active && isFallbackRoute(r)) ?? null;
}
