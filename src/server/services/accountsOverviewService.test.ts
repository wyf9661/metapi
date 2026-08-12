import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./accountsOverviewService.js');

describe('accountsOverviewService', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-overview-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./accountsOverviewService.js');
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
  });

  beforeEach(async () => {
    // Clear all tables the service reads so tests are isolated.
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  async function seedSite(id: number, name: string, status: string) {
    await db.insert(schema.sites).values({
      id,
      name,
      url: `https://${name}.example.com`,
      platform: 'new-api',
      status,
    }).run();
  }

  it('aggregates today spend, reward, and capabilities per account', async () => {
    await seedSite(1, 'site-a', 'active');
    await seedSite(2, 'site-b', 'disabled');

    await db.insert(schema.accounts).values([
      {
        id: 1,
        siteId: 1,
        username: 'user-a',
        accessToken: 'sk-session-token-1',
        status: 'active',
        balance: 100,
      },
      {
        id: 2,
        siteId: 1,
        username: 'user-b',
        // No accessToken → credentialMode defaults to 'apikey' → proxyOnly.
        accessToken: '',
        status: 'active',
        balance: 50,
      },
      {
        id: 3,
        siteId: 2,
        username: 'user-disabled-site',
        accessToken: 'sk-token-3',
        status: 'active',
        balance: 25,
      },
    ]).run();

    // Today spend: proxy logs for account 1 (within today) and account 2.
    // Use a wide window so the rows land inside "today" regardless of local time.
    // NOTE: use the same space-separated UTC format as production
    // (formatUtcSqlDateTime) — ISO "T" timestamps do not compare correctly
    // against range boundaries in SQLite string comparison.
    const { formatUtcSqlDateTime } = await import('./localTimeService.js');
    const now = new Date();
    const storedNow = formatUtcSqlDateTime(now);
    await db.insert(schema.proxyLogs).values([
      {
        id: 1,
        accountId: 1,
        siteId: 1,
        modelRequested: 'gpt-4o',
        status: 'success',
        totalTokens: 100,
        estimatedCost: 1.5,
        createdAt: storedNow,
      },
      {
        id: 2,
        accountId: 1,
        siteId: 1,
        modelRequested: 'gpt-4o',
        status: 'failed',
        totalTokens: 0,
        estimatedCost: 0,
        createdAt: storedNow,
      },
      {
        id: 3,
        accountId: 2,
        siteId: 1,
        modelRequested: 'claude-3',
        status: 'success',
        totalTokens: 50,
        estimatedCost: 0.75,
        createdAt: storedNow,
      },
    ]).run();

    // Models discovered for account 1.
    await db.insert(schema.modelAvailability).values([
      { id: 1, accountId: 1, modelName: 'gpt-4o', available: true },
      { id: 2, accountId: 1, modelName: 'gpt-4o-mini', available: true },
    ]).run();

    // Successful check-in with a reward for account 1.
    await db.insert(schema.checkinLogs).values({
      id: 1,
      accountId: 1,
      status: 'success',
      reward: '1.00',
      message: '签到成功 +1.00',
      createdAt: storedNow,
    }).run();

    const envelope = await service.getAccountsSnapshot({ forceRefresh: true });
    const { accounts } = envelope.payload;

    const byUsername = new Map(accounts.map((a: any) => [a.username, a]));

    // Account 1: session token -> canCheckin/canRefreshBalance, 2 models, spend 1.5
    const a1 = byUsername.get('user-a');
    expect(a1).toBeDefined();
    expect(a1?.todaySpend).toBe(1.5);
    expect(a1?.capabilities.canCheckin).toBe(true);
    expect(a1?.capabilities.canRefreshBalance).toBe(true);
    expect(a1?.capabilities.proxyOnly).toBe(false);
    expect(a1?.runtimeHealth).toBeDefined();

    // Account 2: apikey-only -> proxyOnly, spend 0.75
    const a2 = byUsername.get('user-b');
    expect(a2).toBeDefined();
    expect(a2?.todaySpend).toBe(0.75);
    expect(a2?.capabilities.proxyOnly).toBe(true);
    expect(a2?.capabilities.canCheckin).toBe(false);
    expect(a2?.runtimeHealth).toBeDefined();

    // sites list includes both sites.
    expect(envelope.payload.sites.length).toBe(2);
  });

  it('returns empty accounts when none exist', async () => {
    const envelope = await service.getAccountsSnapshot({ forceRefresh: true });
    expect(envelope.payload.accounts).toEqual([]);
  });
});