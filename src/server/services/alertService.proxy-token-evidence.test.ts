import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sendNotificationMock = vi.fn();
const setAccountRuntimeHealthMock = vi.fn();
vi.mock('./notifyService.js', () => ({ sendNotification: (...args: unknown[]) => sendNotificationMock(...args) }));
vi.mock('./accountHealthService.js', () => ({ setAccountRuntimeHealth: (...args: unknown[]) => setAccountRuntimeHealthMock(...args) }));

type DbModule = typeof import('../db/index.js');
type AlertModule = typeof import('./alertService.js');

describe('proxy token expiry with persisted success evidence', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let alerts: AlertModule;
  let accountId: number;
  let otherAccountId: number;
  let siteId: number;
  let dataDir: string;
  const now = new Date('2026-11-10T07:47:18.000Z');

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-auth-evidence-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    alerts = await import('./alertService.js');
    const site = await db.insert(schema.sites).values({ name: 'relay', url: 'https://relay.example.com', platform: 'new-api' }).returning().get();
    siteId = site.id;
    const account = await db.insert(schema.accounts).values({ siteId, username: 'relay-user', accessToken: 'session-token', status: 'active' }).returning().get();
    accountId = account.id;
    const other = await db.insert(schema.accounts).values({ siteId, username: 'other-user', accessToken: 'other-session', status: 'active' }).returning().get();
    otherAccountId = other.id;
  });

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
    alerts.__resetTokenExpiredSightingStateForTests();
    sendNotificationMock.mockReset();
    setAccountRuntimeHealthMock.mockReset();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.events).run();
    await db.update(schema.accounts).set({ status: 'active' }).run();
  });

  afterAll(() => {
    vi.restoreAllMocks();
    delete process.env.DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function addSuccess(tokenId: number | null = 229, createdAt = '2026-11-10 07:44:19', owner = accountId) {
    await db.insert(schema.proxyLogs).values({ accountId: owner, tokenId, channelId: 814923, status: 'success', httpStatus: 200, createdAt }).run();
  }

  async function reportTwice(proxyTokenId: number | null = 229) {
    await alerts.reportTokenExpired({ accountId, siteId, proxyTokenId, detail: 'HTTP 401' });
    await alerts.reportTokenExpired({ accountId, siteId, proxyTokenId, detail: 'HTTP 401' });
  }

  async function expectSilence() {
    expect(await db.select().from(schema.events).all()).toEqual([]);
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(setAccountRuntimeHealthMock).not.toHaveBeenCalled();
  }

  it('keeps the account active when the same key alternates between 200 and 401', async () => {
    await addSuccess();
    await db.insert(schema.proxyLogs).values({ accountId, tokenId: 229, channelId: 814922, status: 'failed', httpStatus: 401, createdAt: '2026-11-10 07:46:24' }).run();
    await reportTwice();
    await expectSilence();
    const account = (await db.select().from(schema.accounts).all()).find(row => row.id === accountId);
    expect(account?.status).toBe('active');
    expect((await db.select().from(schema.proxyLogs).all()).map(row => row.httpStatus)).toEqual([200, 401]);
  });

  it('clears an earlier failure sighting after same-key proxy success evidence', async () => {
    await alerts.reportTokenExpired({ accountId, siteId, proxyTokenId: 229, detail: 'HTTP 401' });
    await addSuccess();
    await reportTwice();
    expect(await db.select().from(schema.events).all()).toEqual([]);
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.accounts).all()).find(row => row.id === accountId)?.status).toBe('active');
  });

  it('does not mix expiry sightings across proxy keys on the same account', async () => {
    await alerts.reportTokenExpired({ accountId, siteId, proxyTokenId: 229, detail: 'HTTP 401' });
    await alerts.reportTokenExpired({ accountId, siteId, proxyTokenId: 230, detail: 'HTTP 401' });
    await alerts.reportTokenExpired({ accountId, siteId, proxyTokenId: 229, detail: 'HTTP 401' });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('does not mix a management-session sighting with proxy API-key failures', async () => {
    await alerts.reportTokenExpired({ accountId, siteId, detail: 'access token 无效' });
    await alerts.reportTokenExpired({ accountId, siteId, proxyTokenId: 229, detail: 'HTTP 401' });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    await alerts.reportTokenExpired({ accountId, siteId, detail: 'access token 无效' });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse another key\'s success from the same account', async () => {
    await addSuccess(230);
    await reportTwice(229);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.events).all()).toHaveLength(1);
  });

  it('does not reuse a successful request from another account', async () => {
    await addSuccess(229, '2026-11-10 07:44:19', otherAccountId);
    await reportTwice();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('does not mix a management-session sighting with proxy API-key failures', async () => {
    await alerts.reportTokenExpired({ accountId, siteId, detail: 'access token 无效' });
    await alerts.reportTokenExpired({ accountId, siteId, proxyTokenId: 229, detail: 'HTTP 401' });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    await alerts.reportTokenExpired({ accountId, siteId, detail: 'access token 无效' });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a proxy success hide an expired management session', async () => {
    await addSuccess();
    await alerts.reportTokenExpired({ accountId, siteId, detail: 'access token 无效' });
    await alerts.reportTokenExpired({ accountId, siteId, detail: 'access token 无效' });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses false expiry for an account-level API key without a token row', async () => {
    await addSuccess(null);
    await reportTwice(null);
    await expectSilence();
  });

  it('confirms expiry once the last successful request leaves the evidence window', async () => {
    await addSuccess(229, '2026-11-10 07:37:17');
    await reportTwice();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('does not count future-dated success as credential evidence', async () => {
    await addSuccess(229, '2026-11-10 07:47:19');
    await reportTwice();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });
});
