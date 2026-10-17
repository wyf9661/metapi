import { describe, expect, it } from 'vitest';
import {
  CONNECTIVITY_WINDOW_HARD_FAILURE_LIMIT,
  emptyConnectivityHealth,
  recordConnectivityAttempt,
  shouldMarkDisconnected,
  type ConnectivityHealth,
} from './routeConnectivityPolicy.js';

function apply(
  outcomes: Array<'success' | 'hard_failure'>,
): ConnectivityHealth {
  return outcomes.reduce(
    (state, outcome) => recordConnectivityAttempt(state, outcome),
    emptyConnectivityHealth(),
  );
}

describe('routeConnectivityPolicy', () => {
  it('does not disconnect on a single hard failure', () => {
    const state = apply(['hard_failure']);
    expect(state.consecutiveHardFailures).toBe(1);
    expect(shouldMarkDisconnected(state)).toBe(false);
  });

  it('disconnects after two consecutive hard failures', () => {
    expect(shouldMarkDisconnected(apply(['hard_failure', 'hard_failure']))).toBe(true);
  });

  it('clears the streak on any success', () => {
    const afterSuccess = apply(['hard_failure', 'success']);
    expect(afterSuccess.consecutiveHardFailures).toBe(0);
    expect(afterSuccess.consecutiveSuccesses).toBe(1);

    const afterFailureAgain = apply(['hard_failure', 'success', 'hard_failure']);
    expect(afterFailureAgain.consecutiveHardFailures).toBe(1);
    expect(afterFailureAgain.consecutiveSuccesses).toBe(0);
    expect(shouldMarkDisconnected(afterFailureAgain)).toBe(false);
  });

  it('disconnects on a flapping channel once the window has enough evidence', () => {
    // 6 attempts, 4 hard failures: below the consecutive rule, above the window rule.
    const flapping = apply([
      'hard_failure', 'success', 'hard_failure', 'hard_failure', 'success', 'hard_failure',
    ]);
    expect(flapping.consecutiveHardFailures).toBe(1);
    expect(shouldMarkDisconnected(flapping)).toBe(true);
  });

  it('keeps a mostly-healthy channel eligible', () => {
    const healthy = apply([
      'success', 'success', 'hard_failure', 'success', 'success', 'success',
    ]);
    expect(shouldMarkDisconnected(healthy)).toBe(false);
  });

  it('caps the window at ten samples and only counts the most recent ones', () => {
    // Six early failures roll out of the window as successes arrive.
    const state = apply([
      'hard_failure', 'hard_failure', 'hard_failure', 'hard_failure', 'hard_failure',
      'success', 'success', 'success', 'success', 'success',
      'success', 'success',
    ]);
    expect(state.hardFailureSamples).toBe(10);
    // The window holds the three oldest failures: bits 9..7 are set.
    expect(state.hardFailureBits & 0b1111111111).toBe(0b1110000000);
    expect(shouldMarkDisconnected(state)).toBe(false);
    expect(state.consecutiveSuccesses).toBe(7);
  });

  it('exposes the window rule threshold used by the router', () => {
    expect(CONNECTIVITY_WINDOW_HARD_FAILURE_LIMIT).toBe(4);
  });
});
