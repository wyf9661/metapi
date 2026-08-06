import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

type RateLimitOptions = {
  bucket: string;
  max: number;
  windowMs: number;
  message?: string;
};

const DEFAULT_MESSAGE = '请求过于频繁，请稍后再试';

// Track created limiters + the keys each has seen so tests can reset state.
// rate-limiter-flexible has no clear-all on RateLimiterMemory, so we remember
// consumed keys per bucket and delete them on reset.
const activeLimiters = new Set<{
  limiter: RateLimiterMemory;
  seenKeys: Set<string>;
}>();

function normalizeIp(rawIp: string | null | undefined): string {
  const ip = (rawIp || '').trim();
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length).trim() || 'unknown';
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function extractClientIp(request: FastifyRequest): string {
  return normalizeIp(request.ip);
}

export function resetRequestRateLimitStore(): void {
  for (const entry of activeLimiters) {
    for (const key of entry.seenKeys) {
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
  const seenKeys = new Set<string>();
  activeLimiters.add({ limiter, seenKeys });

  return async function rateLimitGuard(request: FastifyRequest, reply: FastifyReply) {
    const key = extractClientIp(request);
    seenKeys.add(key);
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