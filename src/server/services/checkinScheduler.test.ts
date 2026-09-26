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
const sendNotificationMock = vi.fn(async () => undefined);
const intervalAccounts = [
  { accounts: { id: 201, checkinEnabled: true, status: 'active', lastCheckinAt: null }, sites: { status: 'active' } },
];
const selectAllMock = vi.fn();

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
    all: () => selectAllMock(),
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

vi.mock('./checkinService.js', async (importOriginal) => {
  // 只替掉会打网络的 checkinAll；汇总正文用真实实现，测试才有意义
  const actual = await importOriginal<typeof import('./checkinService.js')>();
  return {
    ...actual,
    checkinAll: (...args: unknown[]) => allMock(...args),
  };
});

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

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
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
    sendNotificationMock.mockReset();
    selectAllMock.mockReset().mockReturnValue([]);
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
    // Model discovery is decoupled from the balance pass (2026-09-09 CAIC:
    // a wedged balance pass stalled the shared model refresh for hours).
    expect(refreshModelsAndRebuildRoutesMock).not.toHaveBeenCalled();

    refreshAllBalancesMock.mockResolvedValue(undefined);
    await balanceCallback();
    expect(refreshAllBalancesMock).toHaveBeenCalledTimes(2);
    expect(refreshModelsAndRebuildRoutesMock).not.toHaveBeenCalled();
  });

  it('runs model refresh on its own cron and deduplicates overlapping passes', async () => {
    let releaseRefresh!: () => void;
    refreshModelsAndRebuildRoutesMock.mockImplementation(() => new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    }));
    refreshAllBalancesMock.mockResolvedValue(undefined);
    const scheduler = await import('./checkinScheduler.js');
    await scheduler.startScheduler();
    const modelCall = (scheduleMock.mock.calls as unknown as Array<[string, () => Promise<void>]>)
      .find((call) => call[0] === '*/30 * * * *');
    expect(modelCall).toBeDefined();
    const modelCallback = modelCall![1];

    const first = modelCallback();
    const second = modelCallback();
    expect(refreshModelsAndRebuildRoutesMock).toHaveBeenCalledTimes(1);
    releaseRefresh();
    await Promise.all([first, second]);

    refreshModelsAndRebuildRoutesMock.mockResolvedValue(undefined);
    await modelCallback();
    expect(refreshModelsAndRebuildRoutesMock).toHaveBeenCalledTimes(2);
  });

  it('stopScheduler tears down every timer this module owns', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    refreshAllBalancesMock.mockResolvedValue(undefined);
    refreshModelsAndRebuildRoutesMock.mockResolvedValue(undefined);
    const scheduler = await import('./checkinScheduler.js');

    await scheduler.startScheduler();
    // startScheduler registers the check-in, balance, model-refresh,
    // daily-summary and log-cleanup cron tasks plus the models.dev price sync.
    const scheduledCount = scheduleMock.mock.calls.length;
    expect(scheduledCount).toBeGreaterThanOrEqual(5);
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

  it('deduplicates overlapping interval check-in passes and sends one summary', async () => {
    let releaseCheckin!: () => void;
    allMock.mockImplementation(() => new Promise<unknown[]>((resolve) => {
      releaseCheckin = () => resolve([]);
    }));
    const scheduler = await import('./checkinScheduler.js');
    scheduler.updateCheckinSchedule({ mode: 'cron', cronExpr: '3 3 * * *', intervalHours: 6 });
    const checkinCall = (scheduleMock.mock.calls as unknown as Array<[string, () => Promise<void>]>)
      .find((call) => call[0] === '3 3 * * *');
    expect(checkinCall).toBeDefined();
    const checkinCallback = checkinCall![1];

    const first = checkinCallback();
    const second = checkinCallback();
    expect(allMock).toHaveBeenCalledTimes(1);
    expect(allMock).toHaveBeenCalledWith({ scheduleMode: 'cron' });
    releaseCheckin();
    await Promise.all([first, second]);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledWith(
      '签到完成（成功0）',
      '成功 0 ｜ 跳过 0 ｜ 失败 0',
      'info',
      expect.objectContaining({ bypassThrottle: true }),
    );
    expect(allMock).toHaveBeenCalledTimes(1);

    // Lock cleared → the next tick runs a fresh pass.
    allMock.mockResolvedValue([]);
    await checkinCallback();
    expect(allMock).toHaveBeenCalledTimes(2);
  });

  it('renders one counts line plus non-success rows grouped by reason', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const notification = scheduler.buildCheckinSummaryNotification([
      { accountId: 1, username: 'u1', site: '咕嘎咕嘎公益站', result: { success: false, status: 'failed', message: 'Invalid URL (POST /api/user/sign_in)' } },
      { accountId: 2, username: 'u2', site: 'CoeeApi', result: { success: false, status: 'failed', message: 'fetch failed' } },
      { accountId: 3, username: 'u3', site: 'liWAN LAB', result: { success: true, status: 'success' } },
      { accountId: 4, username: 'u4', site: '大喵喵API', result: { success: false, status: 'skipped', skipped: true, message: '站点开启了 Turnstile 校验，需要人工签到' } },
    ]);

    expect(notification.title).toBe('签到完成（成功1/失败2）');
    expect(notification.level).toBe('warning');
    expect(notification.message.split('\n')).toEqual([
      '成功 1 ｜ 跳过 1 ｜ 失败 2',
      '',
      '**失败（2）**',
      '- 咕嘎咕嘎公益站：Invalid URL (POST /api/user/sign_in)',
      '- CoeeApi：fetch failed',
      '',
      '**跳过（1）**',
      '- 大喵喵API：站点开启了 Turnstile 校验，需要人工签到',
    ]);
    // 成功账号只计数不列名（12 个成功账号曾经把消息刷成一屏）
    expect(notification.message).not.toContain('liWAN LAB');
    expect(notification.message).not.toContain('u3');
    expect(notification.message).not.toContain('u1');
  });

  it('keeps a clean one-line summary when nothing failed and collapses long lists', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const clean = scheduler.buildCheckinSummaryNotification([
      { accountId: 1, username: 'u1', site: 'site-a', result: { success: true, status: 'success' } },
      { accountId: 2, username: 'u2', site: 'site-b', result: { success: false, status: 'skipped', skipped: true, message: 'Turnstile' } },
    ]);
    expect(clean.title).toBe('签到完成（成功1）');
    expect(clean.level).toBe('info');
    expect(clean.message).toBe('成功 1 ｜ 跳过 1 ｜ 失败 0\n\n**跳过（1）**\n- site-b：Turnstile');

    // 同名原因归并到一行，站点超过 3 个时折叠
    const manySites = Array.from({ length: 5 }, (_, index) => ({
      accountId: index,
      username: `u${index}`,
      site: `site-${index}`,
      result: { success: false, status: 'failed', message: 'boom' },
    }));
    const collapsed = scheduler.buildCheckinSummaryNotification(manySites);
    expect(collapsed.message).toContain('- site-0、site-1、site-2等 5 个站点：boom');
  });
});
