/**
 * Bounded, insertion-ordered cache with FIFO eviction.
 *
 * Module-level `Map`s used as caches (pricing, routing reference cost, …) grow
 * without bound when keys are derived from user data (site / account ids): a TTL
 * expires an entry logically but never frees its slot, so a long-running process
 * leaks one entry per distinct key seen since boot. This wraps a Map with a hard
 * entry ceiling and evicts the oldest-inserted key on overflow.
 *
 * Re-setting an existing key refreshes its position (delete-then-set), so keys
 * that are still being written are evicted last — the hot set survives.
 */
export interface BoundedCache<K, V> {
  readonly size: number;
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  clear(): void;
  /** Live keys, in recency order (for targeted invalidation). */
  keys(): IterableIterator<K>;
}

export function createBoundedCache<K, V>(maxEntries: number): BoundedCache<K, V> {
  const limit = Math.max(1, Math.trunc(maxEntries));
  const store = new Map<K, V>();

  const evictOverflow = () => {
    while (store.size > limit) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  };

  return {
    get size() {
      return store.size;
    },
    get(key) {
      return store.get(key);
    },
    has(key) {
      return store.has(key);
    },
    set(key, value) {
      // delete-then-set keeps insertion order == recency order, so the first
      // key is always the least recently written.
      store.delete(key);
      store.set(key, value);
      evictOverflow();
    },
    delete(key) {
      return store.delete(key);
    },
    clear() {
      store.clear();
    },
    keys() {
      return store.keys();
    },
  };
}
