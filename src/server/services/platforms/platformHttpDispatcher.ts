/**
 * Bounded HTTP dispatcher for upstream traffic.
 *
 * Management calls already abort after UPSTREAM_MANAGEMENT_REQUEST_TIMEOUT_MS,
 * but an aborted fetch is not the same as a released socket: a half-open
 * keep-alive connection to an upstream can sit in the pool and make every later
 * call to that host fail until the process restarts (2026-09-28: every
 * cookie/user management variant failed for 18h while token-scoped balance reads
 * kept working on a different path).
 *
 * A dedicated undici Agent with short keep-alive and header/body timeouts drops
 * such connections in minutes. It is installed as the global dispatcher once at
 * boot, so every undici `fetch` in the process (adapters import undici
 * dynamically) is covered without touching individual call sites. Same requests,
 * same bodies, same headers: only connection lifetime changes.
 */
import { Agent, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

export const platformHttpDispatcherTimeouts = {
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  headersTimeout: 35_000,
  bodyTimeout: 65_000,
  connections: 64,
} as const;

let installed: Dispatcher | null = null;

/** Idempotent: installs the bounded Agent once and returns it on later calls. */
export function installBoundedPlatformDispatcher(): Dispatcher {
  if (installed) return installed;
  installed = new Agent({
    keepAliveTimeout: platformHttpDispatcherTimeouts.keepAliveTimeout,
    keepAliveMaxTimeout: platformHttpDispatcherTimeouts.keepAliveMaxTimeout,
    headersTimeout: platformHttpDispatcherTimeouts.headersTimeout,
    bodyTimeout: platformHttpDispatcherTimeouts.bodyTimeout,
    connections: platformHttpDispatcherTimeouts.connections,
  });
  setGlobalDispatcher(installed);
  return installed;
}

export function getInstalledPlatformDispatcher(): Dispatcher | null {
  return installed;
}

/** Test hook: forget the installed agent and restore the previous dispatcher. */
export function __resetPlatformHttpDispatcherForTests(): void {
  installed = null;
  setGlobalDispatcher(new Agent());
}
