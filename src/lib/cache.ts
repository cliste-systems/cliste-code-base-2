/**
 * Tiny in-process TTL cache. Used to keep the per-call hot path off Supabase
 * for read-mostly data (salon config + services) without introducing Redis.
 *
 * Scope: the worker process. Cache lives only as long as the Node process —
 * fine for our short-lived call sessions, and a salon-data update from the
 * dashboard is reflected within `ttlMs` on the next call (default 60s).
 *
 * NOTE: This cache stores plain salon config + service catalogue rows only,
 * never any per-caller PII. Do not extend it to cache `appointments` / call
 * logs without a fresh GDPR review.
 */

type Entry<T> = { value: T; expiresAt: number };

const store = new Map<string, Entry<unknown>>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }
  const value = await loader();
  store.set(key, { value, expiresAt: now + Math.max(0, ttlMs) });
  return value;
}

/** Force-evict a key (for tests, or after a known dashboard update). */
export function invalidate(key: string): void {
  store.delete(key);
}

/** Drop everything (used by retention/erase scripts). */
export function clearAllCachedEntries(): void {
  store.clear();
}
