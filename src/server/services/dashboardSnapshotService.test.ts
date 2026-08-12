import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./dashboardSnapshotService.js');

describe('dashboardSnapshotService', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-dashboard-snapshot-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./dashboardSnapshotService.js');
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
  });

  beforeEach(async () => {
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.siteDayUsage).run();
    await db.delete(schema.siteHourUsage).run();
    await db.delete(schema.modelDayUsage).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  it('aggregates balance, spend, proxy24h, and checkin stats', async () => {
    const { formatUtcSqlDateTime } =
      await import('./localTimeService.js');
    const now = formatUtcSqlDateTime(new Date());

    // Two sites: one active, one disabled.
    await db.insert(schema.sites).values([
      { id: 1, name: 'site-a', url: 'https://site-a.example.com', platform: 'new-api', status: 'active' },
      { id: 2, name: 'site-b', url: 'https://site-b.example.com', platform: 'new-api', status: 'disabled' },
    ]).run();

    // Accounts: 2 active on active site, 1 disabled, 1 on disabled site.
    await db.insert(schema.accounts).values([
      { id: 1, siteId: 1, username: 'a1', accessToken: 'sk-1', status: 'active', balance: 100 },
      { id: 2, siteId: 1, username: 'a2', accessToken: 'sk-2', status: 'active', balance: 50 },
      { id: 3, siteId: 1, username: 'a3', accessToken: 'sk-3', status: 'disabled', balance: 25 },
      { id: 4, siteId: 2, username: 'a4', accessToken: 'sk-4', status: 'active', balance: 10 },
    ]).run();

    // Proxy logs in the last 24h (active site only counts): 2 success + 1 failed.
    await db.insert(schema.proxyLogs).values([
      { id: 1, accountId: 1, siteId: 1, modelRequested: 'gpt-4o', status: 'success', totalTokens: 100, estimatedCost: 1, createdAt: now },
      { id: 2, accountId: 2, siteId: 1, modelRequested: 'gpt-4o', status: 'success', totalTokens: 50, estimatedCost: 0.5, createdAt: now },
      { id: 3, accountId: 2, siteId: 1, modelRequested: 'claude-3', status: 'failed', totalTokens: 0, estimatedCost: 0, createdAt: now },
      // Disabled site must NOT count in proxy24h.
      { id: 4, accountId: 4, siteId: 2, modelRequested: 'gpt-4o', status: 'success', totalTokens: 999, estimatedCost: 9, createdAt: now },
    ]).run();

    // Today spend is projected from proxy_logs by runUsageAggregationProjectionPass()
    // (site_day_usage rows are upserted with additive totals), so we do NOT
    // seed site_day_usage manually — the projection pass derives it.
    // Active site logs: 1 + 0.5 spend → todaySpend 1.5.

    // Check-in: 1 success on site-a (account 1), 1 failed on site-a (account 2).
    await db.insert(schema.checkinLogs).values([
      { id: 1, accountId: 1, status: 'success', reward: '0.50', message: '签到成功 +0.50', createdAt: now },
      { id: 2, accountId: 2, status: 'failed', reward: '', message: '签到失败', createdAt: now },
    ]).run();

    const envelope = await service.getDashboardSummarySnapshot({ forceRefresh: true });
    const payload = envelope.payload;

    // Balance: all accounts on ACTIVE sites count (regardless of account
    // status — a disabled account still holds a balance asset).
    expect(payload.totalBalance).toBe(175); // 100 + 50 + 25 (excludes disabled site's 10)
    expect(payload.activeAccounts).toBe(2); // a1, a2 (both active on active site)
    expect(payload.totalAccounts).toBe(3); // a1, a2, a3 (all on active site)

    expect(payload.todaySpend).toBe(1.5); // from site_day_usage

    // proxy24h excludes the disabled site.
    expect(payload.proxy24h.total).toBe(3);
    expect(payload.proxy24h.success).toBe(2);
    expect(payload.proxy24h.failed).toBe(1);
    expect(payload.proxy24h.totalTokens).toBe(150);

    // Checkin: one site counted once, success wins over failed.
    expect(payload.todayCheckin.total).toBe(1);
    expect(payload.todayCheckin.success).toBe(1);
    expect(payload.todayCheckin.failed).toBe(0);

    expect(payload.performance.requestsPerMinute).toBeGreaterThanOrEqual(0);
  });

  it('returns zeroed summary when no data exists', async () => {
    const envelope = await service.getDashboardSummarySnapshot({ forceRefresh: true });
    const payload = envelope.payload;
    expect(payload.totalBalance).toBe(0);
    expect(payload.activeAccounts).toBe(0);
    expect(payload.totalAccounts).toBe(0);
    expect(payload.todaySpend).toBe(0);
    expect(payload.proxy24h.total).toBe(0);
    expect(payload.todayCheckin.total).toBe(0);
  });
});