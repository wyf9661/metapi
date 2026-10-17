/**
 * Connectivity health policy for the routing "soft avoid" layer.
 *
 * `model_availability.connectivity = false` removes an account+model from the
 * candidate pool whenever at least one other candidate is not known-false, so a
 * single failed request used to cost a channel up to the full TTL in traffic.
 * Measured on production: 24% of failures are 4xx/429 (not reachability) and a
 * 94.6%-success site lost ~24% of its available time to one-off hiccups.
 *
 * The flag now requires evidence:
 *   - two consecutive transport-level failures, or
 *   - at least 4 hard failures in the last 10 attempts (minimum 6 samples).
 * Any success clears the consecutive-failure streak; a successful probe clears
 * the whole window. Non-transport failures (4xx/429) never enter the window —
 * they are request-shape/policy signals handled by channel cooldowns.
 */

export const CONNECTIVITY_WINDOW_SIZE = 10;
export const CONNECTIVITY_CONSECUTIVE_HARD_FAILURE_LIMIT = 2;
export const CONNECTIVITY_WINDOW_MIN_SAMPLES = 6;
export const CONNECTIVITY_WINDOW_HARD_FAILURE_LIMIT = 4;
const CONNECTIVITY_WINDOW_MASK = (1 << CONNECTIVITY_WINDOW_SIZE) - 1;

export type ConnectivityHealth = {
  consecutiveHardFailures: number;
  consecutiveSuccesses: number;
  /** Bit i = outcome of the i-th most recent attempt (1 = hard failure). */
  hardFailureBits: number;
  hardFailureSamples: number;
};

export type ConnectivityOutcome = 'success' | 'hard_failure';

export function emptyConnectivityHealth(): ConnectivityHealth {
  return {
    consecutiveHardFailures: 0,
    consecutiveSuccesses: 0,
    hardFailureBits: 0,
    hardFailureSamples: 0,
  };
}

export function recordConnectivityAttempt(
  state: ConnectivityHealth,
  outcome: ConnectivityOutcome,
): ConnectivityHealth {
  const hardFailure = outcome === 'hard_failure';
  return {
    consecutiveHardFailures: hardFailure ? state.consecutiveHardFailures + 1 : 0,
    consecutiveSuccesses: hardFailure ? 0 : state.consecutiveSuccesses + 1,
    hardFailureBits: ((state.hardFailureBits << 1) | (hardFailure ? 1 : 0)) & CONNECTIVITY_WINDOW_MASK,
    hardFailureSamples: Math.min(CONNECTIVITY_WINDOW_SIZE, state.hardFailureSamples + 1),
  };
}

function countHardFailures(bits: number, samples: number): number {
  const mask = samples >= CONNECTIVITY_WINDOW_SIZE
    ? CONNECTIVITY_WINDOW_MASK
    : (1 << Math.max(0, samples)) - 1;
  let value = bits & mask;
  let count = 0;
  while (value > 0) {
    count += value & 1;
    value >>>= 1;
  }
  return count;
}

/** Whether the accumulated evidence justifies soft-avoiding the channel. */
export function shouldMarkDisconnected(state: ConnectivityHealth): boolean {
  if (state.consecutiveHardFailures >= CONNECTIVITY_CONSECUTIVE_HARD_FAILURE_LIMIT) {
    return true;
  }
  if (state.hardFailureSamples < CONNECTIVITY_WINDOW_MIN_SAMPLES) {
    return false;
  }
  return countHardFailures(state.hardFailureBits, state.hardFailureSamples)
    >= CONNECTIVITY_WINDOW_HARD_FAILURE_LIMIT;
}
