import { afterEach, describe, expect, it } from 'vitest';
import { Agent, getGlobalDispatcher } from 'undici';
import {
  __resetPlatformHttpDispatcherForTests,
  getInstalledPlatformDispatcher,
  installBoundedPlatformDispatcher,
  platformHttpDispatcherTimeouts,
} from './platformHttpDispatcher.js';

describe('platform HTTP dispatcher', () => {
  afterEach(() => __resetPlatformHttpDispatcherForTests());

  it('keeps keep-alive and header/body timeouts bounded', () => {
    expect(platformHttpDispatcherTimeouts.keepAliveMaxTimeout).toBeLessThanOrEqual(60_000);
    expect(platformHttpDispatcherTimeouts.headersTimeout)
      .toBeGreaterThan(platformHttpDispatcherTimeouts.keepAliveTimeout);
    expect(platformHttpDispatcherTimeouts.bodyTimeout)
      .toBeGreaterThan(platformHttpDispatcherTimeouts.headersTimeout);
    // Must stay at or above the 30s management abort, otherwise undici would cut
    // the request before the adapter's own bound reports a timeout.
    expect(platformHttpDispatcherTimeouts.headersTimeout).toBeGreaterThanOrEqual(30_000);
  });

  it('installs one bounded agent globally and stays idempotent', () => {
    const first = installBoundedPlatformDispatcher();
    const second = installBoundedPlatformDispatcher();
    expect(first).toBe(second);
    expect(first).toBeInstanceOf(Agent);
    expect(getGlobalDispatcher()).toBe(first);
    expect(getInstalledPlatformDispatcher()).toBe(first);
  });
});
