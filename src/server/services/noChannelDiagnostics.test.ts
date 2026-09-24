import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type AlertModule = typeof import('./alertService.js');

/**
 * A no-channel 503 must say WHY the candidate pool was empty.
 *
 * Production symptom this pins: a route with a single channel returns 503
 * "No available channels for this model" while the events table only records
 * "原因=No available channels after retries" — the per-candidate exclusion
 * reasons (which field was unqualified) are computed during selection and then
 * discarded, so a transient exclusion is undiagnosable after the fact.
 */
describe('no-channel diagnostics', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let reportProxyAllFailed: AlertModule['reportProxyAllFailed'];

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-no-channel-diag-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const alertModule = await import('./alertService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    reportProxyAllFailed = alertModule.reportProxyAllFailed;
  });

  beforeEach(async () => {
    await db.delete(schema.events).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  async function seedSingleChannelRoute(input: {
    model: string;
    siteStatus?: string;
  }) {
    const site = await db.insert(schema.sites).values({
      name: `site-${input.model}`,
      url: `https://${input.model}.example.com`,
      platform: 'new-api',
    }).returning().get();
    if (input.siteStatus) {
      await db.run(sql`update sites set status = ${input.siteStatus} where id = ${site.id}`);
    }
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${input.model}`,
      accessToken: 'access-token',
      apiToken: 'sk-token',
      status: 'active',
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: input.model,
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();
    return { site, account, route, channel };
  }

  it('records the candidate exclusion reason on the no-channel event', async () => {
    const model = 'diag-disabled-site-model';
    await seedSingleChannelRoute({ model, siteStatus: 'disabled' });

    const router = new TokenRouter();
    const selected = await router.selectChannel(model);
    expect(selected).toBeNull();

    await reportProxyAllFailed({
      model,
      reason: 'No available channels after retries',
      outcome: 'no_available_channels',
      attemptedChannels: 0,
      configuredAttempts: 5,
    });

    const rows = await db.select().from(schema.events).all();
    const row = rows.find((item) => item.message.includes(model));
    expect(row).toBeTruthy();
    // The legacy text stays; the exclusion reason must be appended.
    expect(row!.message).toContain('No available channels after retries');
    expect(row!.message).toContain('site_disabled');
    expect(row!.message).toContain('站点状态=disabled');
  });

  it('drops a diagnostic once it is older than the attribution window', async () => {
    const { __resetNoChannelDiagnosticsForTests, formatNoChannelDiagnostic, getNoChannelDiagnostic, recordNoChannelDiagnostic } =
      await import('./proxyNoChannelDiagnostics.js');
    __resetNoChannelDiagnosticsForTests();

    const nowMs = Date.UTC(2026, 8, 24, 6, 0, 0);
    recordNoChannelDiagnostic({
      model: 'diag-ttl-model',
      stage: 'no_eligible_candidate',
      poolSize: 1,
      candidates: [{ channelId: 42, reasons: [{ code: 'channel_cooldown', message: '冷却中' }] }],
      nowMs,
    });

    const fresh = getNoChannelDiagnostic('diag-ttl-model', nowMs + 1_000);
    expect(fresh).not.toBeNull();
    expect(formatNoChannelDiagnostic(fresh!)).toBe('候选排除=池 1 个,#42:channel_cooldown(冷却中)');

    // Older than the window: a later failure must not inherit this reason.
    expect(getNoChannelDiagnostic('diag-ttl-model', nowMs + 10 * 60 * 1000)).toBeNull();
    __resetNoChannelDiagnosticsForTests();
  });

  it('does not attach a stale reason when a channel was selectable', async () => {
    const model = 'diag-selectable-model';
    await seedSingleChannelRoute({ model });

    const router = new TokenRouter();
    const selected = await router.selectChannel(model);
    expect(selected).not.toBeNull();

    await reportProxyAllFailed({
      model,
      reason: 'No available channels after retries',
      outcome: 'no_available_channels',
      attemptedChannels: 0,
      configuredAttempts: 5,
    });

    const rows = await db.select().from(schema.events).all();
    const row = rows.find((item) => item.message.includes(model));
    expect(row).toBeTruthy();
    expect(row!.message).not.toContain('site_disabled');
    expect(row!.message).not.toContain('候选排除');
  });
});
