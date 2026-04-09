export type SnapshotCacheStatus =
  | "disabled"
  | "miss"
  | "hit"
  | "stale"
  | "refresh";

export type SnapshotEnvelope<T> = {
  payload: T;
  generatedAt: string;
  cacheStatus: SnapshotCacheStatus;
};

export type PersistedSnapshotRecord<T> = {
  payload: T;
  generatedAt: string;
  expiresAt: string;
  staleUntil: string;
};

export type SnapshotPersistenceAdapter<T> = {
  read: () => Promise<PersistedSnapshotRecord<T> | null>;
  write: (record: PersistedSnapshotRecord<T>) => Promise<void>;
};

type SnapshotCacheEntry<T> = {
  payload?: T;
  generatedAtMs: number;
  expiresAtMs: number;
  staleUntilMs: number;
  inFlight?: Promise<SnapshotEnvelope<T>>;
};

type ReadSnapshotOptions<T> = {
  namespace: string;
  key: string;
  ttlMs: number;
  staleMs?: number;
  forceRefresh?: boolean;
  loader: () => Promise<T>;
  persistence?: SnapshotPersistenceAdapter<T>;
};

const SNAPSHOT_CACHE_MAX_ENTRIES = 64;
const snapshotCache = new Map<string, SnapshotCacheEntry<unknown>>();

function getSnapshotCacheEntry<T>(cacheKey: string) {
  const cached = snapshotCache.get(cacheKey) as SnapshotCacheEntry<T> | undefined;
  if (!cached) return undefined;
  snapshotCache.delete(cacheKey);
  snapshotCache.set(cacheKey, cached as SnapshotCacheEntry<unknown>);
  return cached;
}

function setSnapshotCacheEntry<T>(
  cacheKey: string,
  entry: SnapshotCacheEntry<T>,
) {
  snapshotCache.delete(cacheKey);
  snapshotCache.set(cacheKey, entry as SnapshotCacheEntry<unknown>);

  while (snapshotCache.size > SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldestKey = snapshotCache.keys().next().value;
    if (!oldestKey) break;
    snapshotCache.delete(oldestKey);
  }
}

function shouldBypassSnapshotCache() {
  return !!process.env.VITEST;
}

function buildCacheKey(namespace: string, key: string) {
  return `${namespace}:${key}`;
}

async function loadAndStoreSnapshot<T>(
  cacheKey: string,
  loader: () => Promise<T>,
  ttlMs: number,
  staleMs: number,
  persistence?: SnapshotPersistenceAdapter<T>,
) {
  const payload = await loader();
  const nowMs = Date.now();
  const persistedRecord: PersistedSnapshotRecord<T> = {
    payload,
    generatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + Math.max(1, ttlMs)).toISOString(),
    staleUntil: new Date(
      nowMs + Math.max(Math.max(1, ttlMs), staleMs),
    ).toISOString(),
  };
  const envelope: SnapshotEnvelope<T> = {
    payload,
    generatedAt: persistedRecord.generatedAt,
    cacheStatus: "miss",
  };
  setSnapshotCacheEntry(cacheKey, {
    payload,
    generatedAtMs: nowMs,
    expiresAtMs: nowMs + Math.max(1, ttlMs),
    staleUntilMs: nowMs + Math.max(Math.max(1, ttlMs), staleMs),
  });
  if (persistence) {
    try {
      await persistence.write(persistedRecord);
    } catch (error) {
      console.warn(
        `[snapshotCache] persistence write failed for ${cacheKey}:`,
        error,
      );
    }
  }
  return envelope;
}

function parseSnapshotTimestamp(raw: string): number {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildCacheEntryFromPersistedSnapshot<T>(
  record: PersistedSnapshotRecord<T>,
): SnapshotCacheEntry<T> {
  return {
    payload: record.payload,
    generatedAtMs: parseSnapshotTimestamp(record.generatedAt),
    expiresAtMs: parseSnapshotTimestamp(record.expiresAt),
    staleUntilMs: parseSnapshotTimestamp(record.staleUntil),
  };
}

export async function readSnapshotCache<T>(
  options: ReadSnapshotOptions<T>,
): Promise<SnapshotEnvelope<T>> {
  const staleMs = Math.max(options.ttlMs, options.staleMs ?? options.ttlMs * 6);
  if (shouldBypassSnapshotCache()) {
    const payload = await options.loader();
    return {
      payload,
      generatedAt: new Date().toISOString(),
      cacheStatus: "disabled",
    };
  }

  const cacheKey = buildCacheKey(options.namespace, options.key);
  const nowMs = Date.now();
  let cached = getSnapshotCacheEntry<T>(cacheKey);

  if (!cached && !options.forceRefresh && options.persistence) {
    try {
      const persisted = await options.persistence.read();
      const shared = getSnapshotCacheEntry<T>(cacheKey);
      if (shared) {
        cached = shared;
      } else if (persisted) {
        cached = buildCacheEntryFromPersistedSnapshot(persisted);
        setSnapshotCacheEntry(cacheKey, cached);
      }
    } catch (error) {
      console.warn(
        `[snapshotCache] persistence read failed for ${cacheKey}; falling back to loader:`,
        error,
      );
    }
  }

  cached = getSnapshotCacheEntry<T>(cacheKey) ?? cached;

  if (
    !options.forceRefresh &&
    cached?.payload !== undefined &&
    cached.expiresAtMs > nowMs
  ) {
    return {
      payload: cached.payload,
      generatedAt: new Date(cached.generatedAtMs).toISOString(),
      cacheStatus: "hit",
    };
  }

  if (
    !options.forceRefresh &&
    cached?.payload !== undefined &&
    cached.staleUntilMs > nowMs
  ) {
    if (!cached.inFlight) {
      cached.inFlight = loadAndStoreSnapshot(
        cacheKey,
        options.loader,
        options.ttlMs,
        staleMs,
        options.persistence,
      ).finally(() => {
          const next = snapshotCache.get(cacheKey) as SnapshotCacheEntry<T> | undefined;
          if (next) delete next.inFlight;
        });
      void cached.inFlight.catch((error) => {
        console.error(
          `[snapshotCache] background refresh failed for ${cacheKey}:`,
          error,
        );
      });
      setSnapshotCacheEntry(cacheKey, cached);
    }

    return {
      payload: cached.payload,
      generatedAt: new Date(cached.generatedAtMs).toISOString(),
      cacheStatus: "stale",
    };
  }

  const shared = getSnapshotCacheEntry<T>(cacheKey);
  if (shared?.inFlight) {
    const result = await shared.inFlight;
    return {
      ...result,
      cacheStatus:
        options.forceRefresh || shared.payload !== undefined
          ? "refresh"
          : result.cacheStatus,
    };
  }

  if (cached?.inFlight) {
    const result = await cached.inFlight;
    return {
      ...result,
      cacheStatus:
        options.forceRefresh || cached.payload !== undefined
          ? "refresh"
          : result.cacheStatus,
    };
  }

  const inFlight = loadAndStoreSnapshot(
    cacheKey,
    options.loader,
    options.ttlMs,
    staleMs,
    options.persistence,
  ).finally(() => {
    const next = snapshotCache.get(cacheKey) as
      | SnapshotCacheEntry<T>
      | undefined;
    if (next) delete next.inFlight;
  });

  setSnapshotCacheEntry(cacheKey, {
    payload: cached ? cached.payload : undefined,
    generatedAtMs: cached?.generatedAtMs ?? 0,
    expiresAtMs: cached?.expiresAtMs ?? 0,
    staleUntilMs: cached?.staleUntilMs ?? 0,
    inFlight,
  });

  const result = await inFlight;
  return {
    ...result,
    cacheStatus: options.forceRefresh
      ? "refresh"
      : cached?.payload !== undefined
        ? "refresh"
        : "miss",
  };
}

export function clearSnapshotCache(namespace?: string) {
  if (!namespace) {
    snapshotCache.clear();
    return;
  }
  for (const key of snapshotCache.keys()) {
    if (key.startsWith(`${namespace}:`)) snapshotCache.delete(key);
  }
}
