import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cronStopMock = vi.fn();
const scheduleMock = vi.fn(() => ({
  stop: cronStopMock,
}));
const validateMock = vi.fn(() => true);
const allMock = vi.fn();
const refreshAllBalancesMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const startModelsDevPriceSyncMock = vi.fn();
const stopModelsDevPriceSyncMock = vi.fn();

vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => scheduleMock(...(args as Parameters<typeof scheduleMock>)),
    validate: (...args: unknown[]) => validateMock(...(args as Parameters<typeof validateMock>)),
  },
}));

vi.mock('../db/index.js', () => {
  const queryChain = {
    where: () => queryChain,
    get: () => undefined,
    all: () => [],
    from: () => queryChain,
    innerJoin: () => queryChain,
  };

  return {
    db: {
      select: () => queryChain,
    },
    schema: {
      settings: { key: 'key' },
      accounts: { checkinEnabled: 'checkinEnabled', status: 'status' },
      sites: { id: 'id' },
    },
  };
});

vi.mock('./checkinService.js', () => ({
  checkinAll: (...args: unknown[]) => allMock(...args),
}));

vi.mock('./balanceService.js', () => ({
  refreshAllBalances: (...args: unknown[]) => refreshAllBalancesMock(...args),
}));

vi.mock('./routeRefreshWorkflow.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('./modelPriceCatalogService.js', () => ({
  startModelsDevPriceSync: (...args: unknown[]) => startModelsDevPriceSyncMock(...args),
  stopModelsDevPriceSync: (...args: unknown[]) => stopModelsDevPriceSyncMock(...args),
}));

describe('checkinScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cronStopMock.mockReset();
    scheduleMock.mockClear();
    validateMock.mockClear();
    allMock.mockReset();
    refreshAllBalancesMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    startModelsDevPriceSyncMock.mockReset();
    stopModelsDevPriceSyncMock.mockReset();
  });

  afterEach(async () => {
    const scheduler = await import('./checkinScheduler.js');
    scheduler.__resetCheckinSchedulerForTests();
    vi.useRealTimers();
  });

  it('switches from cron mode to interval mode and back', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '0 8 * * *',
      intervalHours: 6,
    });
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'interval',
      intervalHours: 6,
    });
    expect(cronStopMock).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '5 9 * * *',
      intervalHours: 6,
    });
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
  });

  it('selects due accounts from the last successful checkin time', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date('2026-03-20T12:00:00.000Z');

    expect(scheduler.selectDueIntervalCheckinAccountIds([
      { id: 1, lastCheckinAt: null },
      { id: 2, lastCheckinAt: '2026-03-20T05:59:59.000Z' },
      { id: 3, lastCheckinAt: '2026-03-20T06:30:00.000Z' },
    ], 6, now)).toEqual([1, 2]);
  });

  it('deduplicates overlapping balance cron passes and clears the lock after completion', async () => {
    let releaseRefresh!: () => void;
    refreshAllBalancesMock.mockImplementation(() => new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    }));
    refreshModelsAndRebuildRoutesMock.mockResolvedValue(undefined);
    const scheduler = await import('./checkinScheduler.js');
    await scheduler.startScheduler();
    const balanceCall = (scheduleMock.mock.calls as unknown as Array<[string, () => Promise<void>]>)
      .find((call) => call[0] === '0 * * * *');
    expect(balanceCall).toBeDefined();
    const balanceCallback = balanceCall![1];

    const first = balanceCallback();
    const second = balanceCallback();
    expect(refreshAllBalancesMock).toHaveBeenCalledTimes(1);
    releaseRefresh();
    await Promise.all([first, second]);
    expect(refreshModelsAndRebuildRoutesMock).toHaveBeenCalledTimes(1);

    refreshAllBalancesMock.mockResolvedValue(undefined);
    await balanceCallback();
    expect(refreshAllBalancesMock).toHaveBeenCalledTimes(2);
  });

  it('stopScheduler tears down every timer this module owns', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    refreshAllBalancesMock.mockResolvedValue(undefined);
    refreshModelsAndRebuildRoutesMock.mockResolvedValue(undefined);
    const scheduler = await import('./checkinScheduler.js');

    await scheduler.startScheduler();
    // startScheduler registers the check-in, balance, daily-summary and
    // log-cleanup cron tasks plus the models.dev price sync.
    const scheduledCount = scheduleMock.mock.calls.length;
    expect(scheduledCount).toBeGreaterThanOrEqual(4);
    expect(startModelsDevPriceSyncMock).toHaveBeenCalledTimes(1);

    cronStopMock.mockClear();
    clearIntervalSpy.mockClear();
    scheduler.stopScheduler();

    // Every cron task created by startScheduler is stopped.
    expect(cronStopMock).toHaveBeenCalledTimes(scheduledCount);
    expect(stopModelsDevPriceSyncMock).toHaveBeenCalledTimes(1);

    // Interval mode is torn down through the same entry point.
    scheduler.updateCheckinSchedule({ mode: 'interval', intervalHours: 6 });
    clearIntervalSpy.mockClear();
    scheduler.stopScheduler();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
