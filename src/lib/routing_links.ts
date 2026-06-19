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
  linkDelivery?: 'sms' | 'email' | 'both' | null;
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
    const description =
      typeof entry.description === 'string' ? entry.description.trim() : null;
    const linkDeliveryRaw = entry.linkDelivery;
    const linkDelivery =
      linkDeliveryRaw === 'sms' ||
      linkDeliveryRaw === 'email' ||
      linkDeliveryRaw === 'both'
        ? linkDeliveryRaw
        : null;
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
      description,
      ...(linkDelivery ? { linkDelivery } : {}),
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

export function isLocationRoute(link: RoutingLink): boolean {
  if (link.presetId === 'location') return true;
  const blob = `${link.intent} ${link.label} ${link.keywords ?? ''}`.toLowerCase();
  return blob.includes('direction') || blob.includes('where are you');
}

export function isBookingRoute(link: RoutingLink): boolean {
  if (link.presetId === 'booking-inquiry') return true;
  const blob = `${link.intent} ${link.label} ${link.keywords ?? ''}`.toLowerCase();
  return blob.includes('book') && blob.includes('appointment');
}

export function routeUsesCallerLinkDelivery(link: RoutingLink): boolean {
  return (
    link.targetType === 'link' &&
    Boolean(link.linkDelivery) &&
    (isLocationRoute(link) || isBookingRoute(link))
  );
}

function normalizeRouteKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function routeToolForPrompt(link: RoutingLink): string {
  if (routeUsesCallerLinkDelivery(link)) {
    return 'sendDirectionsLink';
  }
  switch (link.targetType) {
    case 'link':
      return 'sendRoutingLink';
    case 'form':
      return 'sendRoutingFile';
    case 'email':
      return 'sendRoutingEmail';
    case 'whatsapp':
      return 'sendRoutingWhatsApp';
    case 'phone':
      return 'transferToTeam';
    case 'callback':
      return 'takeCallbackMessage';
    default:
      return 'takeCallbackMessage';
  }
}

/** Compact route catalog for the live-call prompt — exact routeIds for tools. */
export function formatRoutesForPrompt(links: RoutingLink[]): string {
  const routes = activeRoutes(links);
  if (routes.length === 0) {
    return '- (No active routes — use takeCallbackMessage for anything you cannot answer.)';
  }
  return routes
    .map((r) => {
      const trigger = routeTrigger(r) || r.intent || r.label || 'route';
      const delivery =
        r.linkDelivery && routeUsesCallerLinkDelivery(r) ? `, delivery: ${r.linkDelivery}` : '';
      const tool = routeToolForPrompt(r);
      return `- routeId: ${r.id} | trigger: ${trigger} | type: ${r.targetType}${delivery} | tool: ${tool}`;
    })
    .join('\n');
}

export function listActiveRouteIds(links: RoutingLink[]): string[] {
  return activeRoutes(links).map((r) => r.id);
}

export function resolveRoute(links: RoutingLink[], routeId: string): RoutingLink | null {
  const raw = routeId.trim();
  if (!raw) return null;

  const exact = links.find((r) => r.id === raw);
  if (exact) return exact;

  const presetKey = raw.startsWith('preset_') ? raw.slice(7) : raw;
  const byPreset = links.find(
    (r) =>
      r.presetId === presetKey ||
      r.id === `preset_${presetKey}` ||
      r.id === presetKey,
  );
  if (byPreset) return byPreset;

  const norm = normalizeRouteKey(raw);
  if (!norm) return null;

  for (const link of links) {
    const candidates = [
      link.id,
      link.presetId ?? '',
      link.label,
      link.intent,
      link.keywords ?? '',
    ];
    for (const c of candidates) {
      const n = normalizeRouteKey(c);
      if (!n) continue;
      if (n === norm || n.includes(norm) || norm.includes(n)) {
        return link;
      }
    }
    if (isBookingRoute(link) && (norm.includes('book') || norm.includes('appointment') || norm.includes('schedule'))) {
      return link;
    }
    if (isLocationRoute(link) && (norm.includes('direction') || norm.includes('location') || norm.includes('where'))) {
      return link;
    }
  }

  if (norm.includes('book') || norm.includes('appointment') || norm === 'booking') {
    const bookingLink = links.find(
      (r) =>
        r.active &&
        r.targetType === 'link' &&
        (routeUsesCallerLinkDelivery(r) || isBookingRoute(r) || /book|fresha|appointment/i.test(r.url)),
    );
    if (bookingLink) return bookingLink;
  }

  return null;
}
