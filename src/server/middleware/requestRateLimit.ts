import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getTrustedClientIp } from './clientIp.js';

type RateLimitOptions = {
  bucket: string;
  max: number;
  windowMs: number;
  message?: string;
};

const DEFAULT_MESSAGE = '请求过于频繁，请稍后再试';

// Bounded per-bucket key bookkeeping so tests can reset limiter state.
// rate-limiter-flexible has no clear-all on RateLimiterMemory, so we remember
// consumed keys per bucket and delete them on reset. The map is LRU-capped:
// without a cap, every unique client IP (e.g. through a public tunnel) would
// accumulate forever — the limiter's own storage self-sweeps expired entries,
// but this side table never expires on its own.
const MAX_SEEN_KEYS_TRACKED = 512;

const activeLimiters = new Set<{
  bucket: string;
  limiter: RateLimiterMemory;
  seenKeys: Map<string, number>;
}>();

/** Test/diagnostic helper: current tracked-key count per bucket. */
export function __getRateLimitSeenKeyStatsForTests(): Array<{ bucket: string; seenKeys: number }> {
  return [...activeLimiters].map((entry) => ({
    bucket: entry.bucket,
    seenKeys: entry.seenKeys.size,
  }));
}

export function resetRequestRateLimitStore(): void {
  for (const entry of activeLimiters) {
    for (const key of entry.seenKeys.keys()) {
      entry.limiter.delete(key).catch(() => undefined);
    }
    entry.seenKeys.clear();
  }
}

export function createRateLimitGuard(options: RateLimitOptions) {
  const message = options.message || DEFAULT_MESSAGE;
  const limiter = new RateLimiterMemory({
    keyPrefix: options.bucket,
    points: options.max,
    duration: Math.max(1, Math.ceil(options.windowMs / 1000)),
  });
  const seenKeys = new Map<string, number>();
  activeLimiters.add({ bucket: options.bucket, limiter, seenKeys });

  return async function rateLimitGuard(request: FastifyRequest, reply: FastifyReply) {
    const key = getTrustedClientIp(request);
    // LRU refresh (delete+set re-inserts at the tail) + cap enforcement, so the
    // tracked set stays bounded under unbounded unique client IPs.
    seenKeys.delete(key);
    seenKeys.set(key, Date.now());
    while (seenKeys.size > MAX_SEEN_KEYS_TRACKED) {
      const oldestKey = seenKeys.keys().next().value;
      if (oldestKey === undefined) break;
      seenKeys.delete(oldestKey);
      limiter.delete(oldestKey).catch(() => undefined);
    }
    try {
      await limiter.consume(key);
    } catch (error) {
      const retryState = error instanceof RateLimiterRes ? error : null;
      const retryAfterSec = Math.max(1, Math.ceil((retryState?.msBeforeNext ?? options.windowMs) / 1000));
      reply
        .code(429)
        .header('retry-after', String(retryAfterSec))
        .send({ success: false, message });
      return;
    }
  };
}