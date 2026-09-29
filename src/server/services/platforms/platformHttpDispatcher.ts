import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

export const platformHttpDispatcherTimeouts = {
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  connections: 64,
} as const;

let installed: Dispatcher | null = null;

/** Idempotent: installs a bounded keep-alive agent for platform HTTP traffic. */
export function installBoundedPlatformDispatcher(): Dispatcher {
  if (installed) return installed;
  installed = new Agent({
    keepAliveTimeout: platformHttpDispatcherTimeouts.keepAliveTimeout,
    keepAliveMaxTimeout: platformHttpDispatcherTimeouts.keepAliveMaxTimeout,
    connections: platformHttpDispatcherTimeouts.connections,
    pipelining: 1,
  });
  setGlobalDispatcher(installed);
  return installed;
}

export function getInstalledPlatformDispatcher(): Dispatcher | null {
  return installed;
}

/** Test hook: restore the dispatcher that was active before this helper. */
export function __resetPlatformHttpDispatcherForTests(previous: Dispatcher = getGlobalDispatcher()): void {
  installed = null;
  setGlobalDispatcher(previous);
}
