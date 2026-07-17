import { afterEach, describe, expect, it, vi } from 'vitest';

const refreshAllRouteDecisionSnapshotsMock = vi.fn();

vi.mock('./routeDecisionRefreshService.js', () => ({
  refreshAllRouteDecisionSnapshots: (...args: unknown[]) => refreshAllRouteDecisionSnapshotsMock(...args),
}));

describe('routeDecisionRefreshScheduler', () => {
  afterEach(async () => {
    vi.useRealTimers();
    refreshAllRouteDecisionSnapshotsMock.mockReset();
    const mod = await import('./routeDecisionRefreshScheduler.js');
    await mod.__resetRouteDecisionRefreshSchedulerForTests();
  });

  it('runs a startup refresh then interval refreshes', async () => {
    vi.useFakeTimers();
    refreshAllRouteDecisionSnapshotsMock.mockResolvedValue({
      exactModelCount: 2,
      wildcardRouteCount: 1,
    });

    const {
      startRouteDecisionRefreshScheduler,
      ROUTE_DECISION_REFRESH_STARTUP_DELAY_MS,
      ROUTE_DECISION_REFRESH_INTERVAL_MS,
    } = await import('./routeDecisionRefreshScheduler.js');

    startRouteDecisionRefreshScheduler(
      ROUTE_DECISION_REFRESH_INTERVAL_MS,
      ROUTE_DECISION_REFRESH_STARTUP_DELAY_MS,
    );

    expect(refreshAllRouteDecisionSnapshotsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ROUTE_DECISION_REFRESH_STARTUP_DELAY_MS);
    expect(refreshAllRouteDecisionSnapshotsMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ROUTE_DECISION_REFRESH_INTERVAL_MS);
    expect(refreshAllRouteDecisionSnapshotsMock).toHaveBeenCalledTimes(2);
  });
});
