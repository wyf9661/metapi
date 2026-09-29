import { afterEach, describe, expect, it } from 'vitest';
import { Agent, getGlobalDispatcher } from 'undici';
import {
  __resetPlatformHttpDispatcherForTests,
  getInstalledPlatformDispatcher,
  installBoundedPlatformDispatcher,
  platformHttpDispatcherTimeouts,
} from './platformHttpDispatcher.js';

describe('platform HTTP dispatcher', () => {
  const previous = getGlobalDispatcher();

  afterEach(() => __resetPlatformHttpDispatcherForTests(previous));

  it('bounds keep-alive lifetime without imposing a response header/body deadline', () => {
    expect(platformHttpDispatcherTimeouts.keepAliveTimeout).toBeLessThanOrEqual(30_000);
    expect(platformHttpDispatcherTimeouts.keepAliveMaxTimeout)
      .toBeGreaterThanOrEqual(platformHttpDispatcherTimeouts.keepAliveTimeout);
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
