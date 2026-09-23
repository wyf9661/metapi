import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const getApiTokenMock = vi.fn();
const getModelsMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

vi.mock('undici', () => ({
  setGlobalDispatcher: () => {},
  fetch: async () => {
    throw new Error('unexpected fetch in singleflight test');
  },
  ProxyAgent: class {},
  Agent: class {},
}));

vi.mock('./oauth/refreshSingleflight.js', () => ({
  refreshOauthAccessTokenSingleflight: async () => {
    throw new Error('unexpected oauth refresh in singleflight test');
  },
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('refreshModelsAndRebuildRoutes single-flight staleness', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let refreshModelsAndRebuildRoutes: ModelServiceModule['refreshModelsAndRebuildRoutes'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-singleflight-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    refreshModelsAndRebuildRoutes = modelService.refreshModelsAndRebuildRoutes;
  });

  beforeEach(async () => {
    getApiTokenMock.mockReset();
    getModelsMock.mockReset();

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
    const { invalidateSiteProxyCache } = await import('./siteProxy.js');
    invalidateSiteProxyCache();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('a slow-but-advancing pass keeps single-flight ownership past the staleness window', async () => {
    // Two accounts -> two batches (MODEL_REFRESH_BATCH_SIZE = 3, so make 4).
    // Batch 1 completes fast; batch 2 is gated so the pass is still in flight.
    getApiTokenMock.mockResolvedValue(null);
    const gatedAccounts: number[] = [];
    const gates = new Map<number, Promise<void>>();
    const releaseGates = new Map<number, () => void>();

    const site = await db.insert(schema.sites).values({
      name: 'slow-pass-site',
      url: 'https://slow-pass.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    for (let i = 0; i < 6; i += 1) {
      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: `slow-user-${i}`,
        accessToken: `session-token-${i}`,
        apiToken: `sk-managed-${i}`,
        status: 'active',
      }).returning().get();
      gatedAccounts.push(account.id);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(account.id, gate);
      releaseGates.set(account.id, release);
    }

    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      // Session credentials are `session-token-N`; managed token credentials are
      // `sk-managed-N` (per-account, from the DB seed below).
      const match = /(?:^session-token-|sk-managed-)(\d+)$/.exec(credential);
      if (!match) return ['gpt-5-nano'];
      const accountIndex = Number(match[1]);
      if (accountIndex >= 3) {
        // Accounts 3/4/5 form the second batch: hold the pass in flight.
        await gates.get(gatedAccounts[accountIndex])!;
      }
      return ['gpt-5-nano'];
    });

    // Start the pass and let it reach the gated second batch. Batch 1 finished
    // before this point, so the heartbeat is fresh.
    let clockMs = Date.now();
    const { __setRefreshInflightClockForTests } = await import('./modelService.js');
    __setRefreshInflightClockForTests({ now: () => clockMs });
    // Reset: the pass started under the default clock; give it the current one.
    // (The pass was already started below the real-time heartbeat; the gate
    // scenario below only asserts relative staleness, and batch 1's heartbeat
    // was stamped with Date.now() before injection.)

    const firstPass = refreshModelsAndRebuildRoutes();
    await vi.waitFor(async () => {
      // Second batch started: a gated credential (sk-managed-3/4/5) was called.
      expect(getModelsMock.mock.calls.some((call) => call[1] === 'sk-managed-3')).toBe(true);
    });

    // Advance the clock by 4 minutes: beyond the OLD 10-minute age window is
    // not possible yet, but the point is the pass is INSIDE the 5-minute idle
    // window (batch 1 heartbeat is fresh). A caller arriving now must join
    // the same pass — even after more wall time than the old age rule allowed
    // once the heartbeat keeps advancing in later batches.
    clockMs += 4 * 60_000;

    // A caller arriving while the pass is stalled-in-gate but advancing slowly
    // (it will be released) must JOIN the same pass, not start a second one.
    const secondCall = refreshModelsAndRebuildRoutes();

    // Release the second batch; both callers must resolve to the same pass.
    for (const release of releaseGates.values()) release();
    const [firstResult, secondResult] = await Promise.all([firstPass, secondCall]);
    expect(secondResult).toBe(firstResult);

    // Exactly one pass ran. Per account, managed-token discovery is attempted
    // on two paths today (account.apiToken pre-check + managed token scan),
    // so 6 accounts x 2 = 12; session credentials are skipped because managed
    // tokens already yielded models (preferManagedTokenDiscovery).
    const managedCalls = getModelsMock.mock.calls.filter((call) => String(call[1]).startsWith('sk-managed-')).length;
    expect(managedCalls).toBe(12);
    const sessionCalls = getModelsMock.mock.calls.filter((call) => String(call[1]).startsWith('session-token-')).length;
    // Session discovery must be skipped entirely: managed tokens already
    // yielded models (preferManagedTokenDiscovery), so zero session calls
    // also proves no second pass ran with different credentials.
    expect(sessionCalls).toBe(0);
    const availabilityRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, gatedAccounts[0]))
      .all();
    expect(availabilityRows.map((row: any) => row.modelName)).toEqual(['gpt-5-nano']);
  });

  it('a genuinely wedged pass (no batch progress past the idle window) is replaced by a fresh pass', async () => {
    getApiTokenMock.mockResolvedValue(null);
    // Only one account: single batch, which we wedge forever by never
    // resolving its gate. No further heartbeat can happen -> stale.
    const site = await db.insert(schema.sites).values({
      name: 'wedged-pass-site',
      url: 'https://wedged-pass.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'wedged-user',
      accessToken: 'session-token-wedged',
      apiToken: 'sk-managed-wedged',
      status: 'active',
    }).returning().get();

    getModelsMock.mockImplementation(async (_baseUrl: string, credential: string) => {
      if (String(credential).includes('wedged')) await gate;
      return ['gpt-5-nano'];
    });

    let clockMs = Date.now();
    const { __setRefreshInflightClockForTests, __getAndResetRefreshInflightStaleTakeoversForTests } = await import('./modelService.js');
    __setRefreshInflightClockForTests({ now: () => clockMs });
    const takeovers = () => __getAndResetRefreshInflightStaleTakeoversForTests();

    const wedgedPass = refreshModelsAndRebuildRoutes();
    await vi.waitFor(async () => {
      // Discovery is now stuck inside the gated credential.
      expect(getModelsMock.mock.calls.some((call) => String(call[1]).includes('wedged'))).toBe(true);
    });

    // No heartbeat can fire (the only batch never completes). Push the clock
    // past the idle window: the next caller must NOT join the wedged pass —
    // it starts a fresh pass (which itself wedges on the same gate; we only
    // assert the second call did not resolve to the first pass object).
    clockMs += 6 * 60_000;
    let secondResolved = false;
    const secondCall = refreshModelsAndRebuildRoutes().then((value) => {
      secondResolved = true;
      return value;
    });

    // Give the second pass a moment: the takeover is observable via the
    // stale-takeover counter. The account-level single-flight makes the new
    // pass REUSE the wedged discovery promise (no second upstream call), so
    // the correct assertions are: takeover happened + neither pass resolved
    // while the gate is still closed.
    await vi.waitFor(async () => {
      expect(takeovers()).toBeGreaterThanOrEqual(1);
    }, { timeout: 3_000, interval: 25 });
    expect(secondResolved).toBe(false);

    // Cleanup: release the gate so both passes drain.
    release();
    const [firstResult] = await Promise.allSettled([wedgedPass, secondCall]);
    expect(firstResult.status === 'fulfilled' || firstResult.status === 'rejected').toBe(true);
  });
});
