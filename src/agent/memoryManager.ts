/**
 * Memory management utilities for SideCar
 * Provides tools to monitor and manage memory usage across the application
 */

/**
 * Cache with TTL and size limits.
 * Exposes a Map-compatible read interface (size, get, set, delete, has, keys, entries).
 */
export class LimitedCache<K, V> {
  private cache = new Map<K, { value: V; timestamp: number }>();
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number = 100, ttl: number = 300000) {
    // 5 minutes default TTL
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  /** Number of live (non-expired) entries. */
  get size(): number {
    return this.cache.size;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end of Map so eviction treats this as most-recently-used.
    // Map preserves insertion order; delete+re-set moves the key to the tail.
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      // Evict the least-recently-used entry (head of Map's insertion order).
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) {
        this.cache.delete(lruKey);
      }
    }

    this.cache.set(key, { value, timestamp: Date.now() });
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  /** Iterate keys (skips expired entries). */
  *keys(): IterableIterator<K> {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      } else {
        yield key;
      }
    }
  }

  /** Iterate [key, value] pairs (skips expired entries). */
  *entries(): IterableIterator<[K, V]> {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      } else {
        yield [key, entry.value];
      }
    }
  }
}
