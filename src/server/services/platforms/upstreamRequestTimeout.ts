import { fetch as undiciFetch } from 'undici';
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

/**
 * fetch() for management/OAuth traffic with the bounded management timeout
 * applied. OAuth token endpoints, device-code polls and userinfo reads are
 * management-class calls too: an unbounded attempt can stall a refresh pass
 * for the undici default (~300 s), so route them through this helper as well.
 * Callers may still override the bound by passing their own `signal`.
 */
export function fetchWithManagementTimeout(
  input: string | URL,
  init?: UndiciRequestInit,
): ReturnType<typeof undiciFetch> {
  return undiciFetch(input, withManagementRequestTimeout(init ?? {}));
}
