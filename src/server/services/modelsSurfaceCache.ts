/**
 * Response cache for the `/v1/models` surface.
 *
 * The listing recomputes routing eligibility for EVERY exposed model on EVERY
 * request (`isModelAllowed` + `explainSelection` per model), which dominated
 * the endpoint's latency once the catalog grew past ~200 models and made
 * clients with short model-listing timeouts (e.g. Hermes' 5s probe) treat a
 * healthy endpoint as unreachable. The cache stores only the filtered
 * model-id list per (response format + downstream policy), so the response
 * payload — including the per-request `created` timestamps — is still
 * rendered fresh on every call.
 *
 * Only NON-EMPTY lists are cached: an empty list means "routes missing", and
 * the surface's refresh-and-reread path must keep running for that case.
 * The policy participates in the key via a canonical JSON fingerprint so two
 * downstream keys with different restrictions never share an entry.
 * Invalidation rides on the token-router cache invalidators: anything that
 * can add/remove models or flip channel availability already calls those.
 */
import { config } from '../config.js';

// Bounded like the other side tables in this subsystem (bounded-gap state,
// rate-limiter seenKeys): keys are per policy fingerprint, and a fleet of
// distinct downstream keys must not grow the map without limit.
const MODELS_SURFACE_CACHE_MAX_ENTRIES = 64;

const MODELS_SURFACE_CACHE_DEFAULT_TTL_MS = 30_000;

type ModelsSurfaceCacheEntry = {
  models: string[];
  expiresAtMs: number;
};

const modelsSurfaceCache = new Map<string, ModelsSurfaceCacheEntry>();

// Single-flight per key: concurrent misses at TTL expiry share one compute,
// so the recomputation cost is paid once instead of once per waiting client.
const modelsSurfaceInFlight = new Map<string, Promise<string[]>>();

export function resolveModelsSurfaceCacheTtlMs(): number {
  const raw = Math.trunc(Number(config.modelsSurfaceCacheTtlMs));
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return MODELS_SURFACE_CACHE_DEFAULT_TTL_MS;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function buildModelsSurfaceCacheKey(
  responseFormat: 'openai' | 'claude',
  downstreamPolicy: unknown,
): string {
  return `${responseFormat}|${canonicalJson(downstreamPolicy ?? null)}`;
}

export function readModelsSurfaceCache(key: string, nowMs: number): string[] | null {
  const entry = modelsSurfaceCache.get(key);
  if (!entry) return null;
  if (nowMs >= entry.expiresAtMs) {
    modelsSurfaceCache.delete(key);
    return null;
  }
  // Map order is the eviction order: re-insert on read so hot keys are evicted
  // last (a plain `get` does not refresh recency).
  modelsSurfaceCache.delete(key);
  modelsSurfaceCache.set(key, entry);
  return entry.models;
}

export function writeModelsSurfaceCache(key: string, models: string[], nowMs: number): void {
  const ttlMs = resolveModelsSurfaceCacheTtlMs();
  if (models.length === 0 || ttlMs <= 0) return;
  modelsSurfaceCache.set(key, { models, expiresAtMs: nowMs + ttlMs });
  while (modelsSurfaceCache.size > MODELS_SURFACE_CACHE_MAX_ENTRIES) {
    const oldest = modelsSurfaceCache.keys().next();
    if (oldest.done) break;
    modelsSurfaceCache.delete(oldest.value);
  }
}

export function invalidateModelsSurfaceCache(): void {
  modelsSurfaceCache.clear();
}

export async function runModelsSurfaceCompute(
  key: string,
  compute: () => Promise<string[]>,
): Promise<string[]> {
  const existing = modelsSurfaceInFlight.get(key);
  if (existing) return existing;
  const promise = compute().finally(() => {
    if (modelsSurfaceInFlight.get(key) === promise) {
      modelsSurfaceInFlight.delete(key);
    }
  });
  modelsSurfaceInFlight.set(key, promise);
  return promise;
}

// Test seam: inspect live cache state without touching the Map from outside.
export function __getModelsSurfaceCacheSizeForTests(): number {
  return modelsSurfaceCache.size;
}
