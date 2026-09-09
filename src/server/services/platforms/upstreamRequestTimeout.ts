import type { RequestInit as UndiciRequestInit } from 'undici';

// Hard timeout for upstream management requests (balance reads, model
// discovery, token sync, check-in, platform detection). Without one, a wedged
// upstream socket stalls each attempt for the undici default
// (headersTimeout 300s); across retries and workers one hourly pass took 13+
// hours and blocked every later pass via the in-flight guard (2026-09-09:
// CAIC lost its whole model list because the scheduled pass never reached a
// retry). Management traffic is low-volume, so a bounded 30s per attempt is
// far more valuable than an unbounded wait.
export const UPSTREAM_MANAGEMENT_REQUEST_TIMEOUT_MS = 30_000;

export function withManagementRequestTimeout(
  options: UndiciRequestInit,
): UndiciRequestInit {
  if (options.signal) return options; // caller-provided signal wins
  return { ...options, signal: AbortSignal.timeout(UPSTREAM_MANAGEMENT_REQUEST_TIMEOUT_MS) };
}
