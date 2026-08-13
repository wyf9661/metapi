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

  it('scheduleRouteDecisionRefresh collapses rapid site mutations into one refresh', async () => {
    vi.useFakeTimers();
    refreshAllRouteDecisionSnapshotsMock.mockResolvedValue({
      exactModelCount: 1,
      wildcardRouteCount: 0,
    });

    const {
      scheduleRouteDecisionRefresh,
      ROUTE_DECISION_REFRESH_SITE_CHANGE_DELAY_MS,
    } = await import('./routeDecisionRefreshScheduler.js');

    // Simulate 5 rapid site weight changes within the debounce window.
    scheduleRouteDecisionRefresh();
    scheduleRouteDecisionRefresh();
    scheduleRouteDecisionRefresh();
    scheduleRouteDecisionRefresh();
    scheduleRouteDecisionRefresh();

    // No refresh yet — debounce window not elapsed.
    expect(refreshAllRouteDecisionSnapshotsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ROUTE_DECISION_REFRESH_SITE_CHANGE_DELAY_MS);
    expect(refreshAllRouteDecisionSnapshotsMock).toHaveBeenCalledTimes(1);
  });

  it('scheduleRouteDecisionRefresh resets debounce window on each call', async () => {
    vi.useFakeTimers();
    refreshAllRouteDecisionSnapshotsMock.mockResolvedValue({
      exactModelCount: 0,
      wildcardRouteCount: 0,
    });

    const {
      scheduleRouteDecisionRefresh,
      ROUTE_DECISION_REFRESH_SITE_CHANGE_DELAY_MS,
    } = await import('./routeDecisionRefreshScheduler.js');

    scheduleRouteDecisionRefresh();

    // Advance partway through the window, then trigger again.
    await vi.advanceTimersByTimeAsync(ROUTE_DECISION_REFRESH_SITE_CHANGE_DELAY_MS - 1000);
    scheduleRouteDecisionRefresh();

    // First call window was cancelled; no refresh yet.
    expect(refreshAllRouteDecisionSnapshotsMock).not.toHaveBeenCalled();

    // Now let the second window elapse fully.
    await vi.advanceTimersByTimeAsync(ROUTE_DECISION_REFRESH_SITE_CHANGE_DELAY_MS);
    expect(refreshAllRouteDecisionSnapshotsMock).toHaveBeenCalledTimes(1);
  });
});
