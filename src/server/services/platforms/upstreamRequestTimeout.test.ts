import { describe, expect, it } from 'vitest';
import {
  UPSTREAM_MANAGEMENT_REQUEST_TIMEOUT_MS,
  withManagementRequestTimeout,
} from './upstreamRequestTimeout.js';

describe('upstream management request timeout', () => {
  it('applies an AbortSignal timeout when the caller provides none', () => {
    const options = withManagementRequestTimeout({ method: 'GET' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    // The signal must be an already-started timer bound to the shared budget.
    expect(options.signal?.aborted).toBe(false);
    expect(UPSTREAM_MANAGEMENT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(UPSTREAM_MANAGEMENT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('preserves a caller-provided signal so custom timeouts win', () => {
    const callerSignal = AbortSignal.timeout(1);
    const options = withManagementRequestTimeout({ method: 'GET', signal: callerSignal });
    expect(options.signal).toBe(callerSignal);
  });
});
