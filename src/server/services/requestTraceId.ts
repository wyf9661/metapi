import { randomBytes } from 'node:crypto';

/**
 * Short, request-scoped correlation id for proxy_logs metadata.
 * Kept compact so UI/log prefixes stay readable: [trace:r_...]
 */
export function createRequestTraceId(): string {
  return `r_${randomBytes(6).toString('hex')}`;
}
