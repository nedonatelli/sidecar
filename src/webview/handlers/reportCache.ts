/**
 * TTL + fingerprint cache for expensive command-handler report builds.
 *
 * `/usage` and `/insights` both rebuild a full markdown report every time
 * they run, even when nothing has changed since the previous invocation.
 * `/insights` in particular walks ~5k audit rows through an analytics
 * pipeline on every call, which is wasteful if you hit the command twice
 * in a row to re-check something.
 *
 * This cache memoizes by `key` with a two-gate invalidation: the cached
 * entry is returned only if (a) the fingerprint of the underlying data
 * still matches and (b) the entry hasn't aged past `ttlMs`. Either
 * condition triggers a recompute. Fingerprints are supplied by the
 * caller so the cache stays agnostic about what "changed" means for
 * each data source.
 */

interface CacheEntry {
  fingerprint: string;
  value: string;
  computedAt: number;
}

const entries = new Map<string, CacheEntry>();

export const DEFAULT_REPORT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * Return the cached report if its fingerprint and TTL both hold; otherwise
 * call `compute`, store the result, and return it.
 */
export async function getOrComputeReport(
  key: string,
  fingerprint: string,
  compute: () => Promise<string> | string,
  ttlMs: number = DEFAULT_REPORT_CACHE_TTL_MS,
): Promise<{ value: string; cacheHit: boolean }> {
  const now = Date.now();
  const existing = entries.get(key);
  if (existing && existing.fingerprint === fingerprint && now - existing.computedAt < ttlMs) {
    return { value: existing.value, cacheHit: true };
  }
  const value = await compute();
  entries.set(key, { fingerprint, value, computedAt: now });
  return { value, cacheHit: false };
}

/** Test / dev helper — drop everything in the cache. */
export function clearReportCache(): void {
  entries.clear();
}

/** Test helper — count live entries. */
export function reportCacheSize(): number {
  return entries.size;
}
