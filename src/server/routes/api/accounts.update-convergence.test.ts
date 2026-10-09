import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForBackgroundTaskToReachTerminalState } from '../../test-fixtures/backgroundTaskTestUtils.js';

const refreshModelsForAccountMock = vi.fn();
const rebuildTokenRoutesFromAvailabilityMock = vi.fn();
const refreshBalanceMock = vi.fn();
const ensureDefaultTokenForAccountMock = vi.fn();
const syncTokensFromUpstreamMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    getModels: vi.fn(),
    verifyToken: vi.fn(),
    getApiTokens: vi.fn(),
  }),
}));

vi.mock('../../services/balanceService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/balanceService.js')>()),
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

vi.mock('../../services/modelService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/modelService.js')>()),
  refreshModelsForAccount: (...args: unknown[]) => refreshModelsForAccountMock(...args),
  rebuildTokenRoutesFromAvailability: (...args: unknown[]) => rebuildTokenRoutesFromAvailabilityMock(...args),
}));

vi.mock('../../services/accountTokenService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/accountTokenService.js')>()),
  ensureDefaultTokenForAccount: (...args: unknown[]) => ensureDefaultTokenForAccountMock(...args),
  syncTokensFromUpstream: (...args: unknown[]) => syncTokensFromUpstreamMock(...args),
}));

type DbModule = typeof import('../../db/index.js');
type BackgroundTaskModule = typeof import('../../services/backgroundTaskService.js');

describe('accounts update convergence', { timeout: 15_000 }, () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let backgroundTasks: BackgroundTaskModule;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-update-convergence-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    backgroundTasks = await import('../../services/backgroundTaskService.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    refreshModelsForAccountMock.mockReset();
    rebuildTokenRoutesFromAvailabilityMock.mockReset();
    refreshBalanceMock.mockReset();
    ensureDefaultTokenForAccountMock.mockReset();
    syncTokensFromUpstreamMock.mockReset();
    refreshModelsForAccountMock.mockResolvedValue({ refreshed: false, status: 'skipped' });
    rebuildTokenRoutesFromAvailabilityMock.mockResolvedValue({ createdRoutes: 0 });
    backgroundTasks.__resetBackgroundTasksForTests();

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
    delete process.env.DATA_DIR;
  });

  async function seedSiteAndAccount(extra: Record<string, unknown> = {}) {
    const site = await db.insert(schema.sites).values({
      name: 'Convergence Site',
      url: 'https://convergence.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'convergence-user',
      accessToken: 'session-token',
      status: 'active',
      ...extra,
    }).returning().get();
    return { site, account };
  }

  it('skips model refresh and route rebuild when only non-credential fields change', async () => {
    const { account } = await seedSiteAndAccount();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}`,
      payload: {
        username: 'convergence-user-renamed',
        status: 'active',
        checkinEnabled: true,
        // The edit panel sends these keys with null values on every save; they
        // must not be treated as a credential change on a non-sub2api site.
        refreshToken: null,
        tokenExpiresAt: null,
        platformUserId: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: account.id,
      username: 'convergence-user-renamed',
    });
    // The slow upstream model discovery must not be triggered by metadata edits.
    expect(refreshModelsForAccountMock).not.toHaveBeenCalled();
    // And no deferred convergence task is queued either.
    expect(backgroundTasks.listBackgroundTasks()
      .some((task) => task.dedupeKey === `account-converge-${account.id}`)).toBe(false);
  });

  it('defers the slow model refresh to a background task instead of blocking the response', async () => {
    const { account } = await seedSiteAndAccount({
      accessToken: '',
      apiToken: 'sk-old',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    });

    refreshModelsForAccountMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { refreshed: true, status: 'success' };
    });

    const startedAt = Date.now();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}`,
      payload: { apiToken: 'sk-new' },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: account.id, apiToken: 'sk-new' });
    // The response must not wait for the ~600ms model refresh.
    expect(elapsedMs).toBeLessThan(300);

    const convergeTask = backgroundTasks.listBackgroundTasks()
      .find((task) => task.dedupeKey === `account-converge-${account.id}`);
    expect(convergeTask).toBeTruthy();

    const settled = await waitForBackgroundTaskToReachTerminalState(
      (taskId) => backgroundTasks.getBackgroundTask(taskId),
      convergeTask!.id,
    );
    expect(settled?.status).toBe('succeeded');
    expect(refreshModelsForAccountMock).toHaveBeenCalledTimes(1);
  });

  it('runs the model refresh synchronously when a credential change is a recovery flow', async () => {
    const { account } = await seedSiteAndAccount({
      accessToken: '',
      apiToken: 'sk-old',
      status: 'expired',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    });

    refreshModelsForAccountMock.mockResolvedValue({ refreshed: true, status: 'success' });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}`,
      payload: { apiToken: 'sk-new' },
    });

    expect(response.statusCode).toBe(200);
    // Recovery must reactivate synchronously so the caller learns the new key works.
    expect(response.json()).toMatchObject({ id: account.id, status: 'active' });
    expect(refreshModelsForAccountMock).toHaveBeenCalledTimes(1);
    expect(backgroundTasks.listBackgroundTasks()
      .some((task) => task.dedupeKey === `account-converge-${account.id}`)).toBe(false);
  });

  it('retries recovery when the same API key is resubmitted for an expired account', async () => {
    const { account } = await seedSiteAndAccount({
      accessToken: '',
      apiToken: 'sk-same',
      status: 'expired',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    });

    refreshModelsForAccountMock.mockResolvedValue({ refreshed: true, status: 'success' });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}`,
      payload: { apiToken: 'sk-same' },
    });

    expect(response.statusCode).toBe(200);
    // Re-submitting the stored key is a deliberate retry signal on an expired
    // account, so recovery still runs synchronously and reactivates it.
    expect(response.json()).toMatchObject({ id: account.id, status: 'active' });
    expect(refreshModelsForAccountMock).toHaveBeenCalledTimes(1);
  });
});
