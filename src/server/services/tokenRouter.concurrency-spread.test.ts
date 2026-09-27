import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteRoutingStrategy } from './routeRoutingStrategy.js';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');
type ProxyChannelCoordinatorModule = typeof import('./proxyChannelCoordinator.js');
type SiteContextModule = typeof import('./siteContextCapabilityService.js');

const mockedCatalogRoutingCost = vi.fn<(
  input: { siteId: number; accountId: number; modelName: string }
) => number | null>(() => null);

vi.mock('./modelPricingService.js', async () => {
  const actual = await vi.importActual<typeof import('./modelPricingService.js')>('./modelPricingService.js');
  return {
    ...actual,
    getCachedModelRoutingReferenceCost: mockedCatalogRoutingCost,
  };
});

/**
 * Concurrency-spread selection (`selectSpreadChannel`): while the affinity
 * channel (sticky / last-success) is already serving a request, the second
 * concurrent hop must pick a DIFFERENT channel — idle first, different site
 * preferred, least-loaded as a last resort — and must return null (fall back
 * to the historical affinity path) whenever no usable alternative exists.
 */
describe('TokenRouter concurrency spread selection', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let config: ConfigModule['config'];
  let resetProxyChannelCoordinatorState: ProxyChannelCoordinatorModule['resetProxyChannelCoordinatorState'];
  let resetSiteContextCapabilityCache: SiteContextModule['__resetSiteContextCapabilityCacheForTests'];
  let dataDir = '';
  let idSeed = 0;
  let originalDefaultRoutingStrategy: RouteRoutingStrategy;

  const nextId = () => {
    idSeed += 1;
    return idSeed;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-spread-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const configModule = await import('../config.js');
    const coordinatorModule = await import('./proxyChannelCoordinator.js');
    const siteContextModule = await import('./siteContextCapabilityService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    config = configModule.config;
    resetProxyChannelCoordinatorState = coordinatorModule.resetProxyChannelCoordinatorState;
    resetSiteContextCapabilityCache = siteContextModule.__resetSiteContextCapabilityCacheForTests;
    originalDefaultRoutingStrategy = config.defaultRoutingStrategy;
  });

  beforeEach(async () => {
    idSeed = 0;
    mockedCatalogRoutingCost.mockReset();
    mockedCatalogRoutingCost.mockReturnValue(null);
    config.defaultRoutingStrategy = 'weighted';
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.siteModelContext).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    resetProxyChannelCoordinatorState();
    resetSiteContextCapabilityCache();
  });

  afterAll(() => {
    config.defaultRoutingStrategy = originalDefaultRoutingStrategy;
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    resetProxyChannelCoordinatorState();
    delete process.env.DATA_DIR;
  });

  async function createRoute(modelPattern: string) {
    return await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();
  }

  async function createSite(namePrefix: string) {
    const id = nextId();
    return await db.insert(schema.sites).values({
      name: `${namePrefix}-${id}`,
      url: `https://${namePrefix}-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
  }

  type ChannelOptions = {
    priority?: number;
    weight?: number;
    failCount?: number;
    lastFailAt?: string | null;
  };

  async function addChannelOnNewSite(
    routeId: number,
    namePrefix: string,
    options: ChannelOptions = {},
  ) {
    const site = await createSite(namePrefix);
    return await addChannelToSite(routeId, site, namePrefix, options);
  }

  async function addChannelToSite(
    routeId: number,
    site: { id: number },
    namePrefix: string,
    options: ChannelOptions = {},
  ) {
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `${namePrefix}-user-${nextId()}`,
      accessToken: `access-${nextId()}`,
      apiToken: `sk-${nextId()}`,
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `${namePrefix}-token`,
      token: `token-${namePrefix}-${nextId()}`,
      enabled: true,
      isDefault: false,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId,
      accountId: account.id,
      tokenId: token.id,
      priority: options.priority ?? 0,
      weight: options.weight ?? 10,
      enabled: true,
      failCount: options.failCount ?? 0,
      lastFailAt: options.lastFailAt ?? null,
    }).returning().get();
    return { site, account, token, channel };
  }

  it('spreads to an idle candidate on another site while the preferred channel is busy', async () => {
    const route = await createRoute('spread-model');
    const preferred = await addChannelOnNewSite(route.id, 'spread-a');
    const alternative = await addChannelOnNewSite(route.id, 'spread-b');

    const selected = await new TokenRouter().selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      { channelLoad: (channelId: number) => (channelId === preferred.channel.id ? 3 : 0) },
    );

    expect(selected?.channel.id).toBe(alternative.channel.id);
    expect(selected?.site.id).toBe(alternative.site.id);
    expect(selected?.tokenValue).toBe(alternative.token.token);
    expect(selected?.actualModel).toBeTruthy();
  });

  it('never picks the busy preferred channel and prefers an idle candidate over busy ones', async () => {
    const route = await createRoute('spread-model');
    const preferred = await addChannelOnNewSite(route.id, 'spread-a');
    const busyAlternative = await addChannelOnNewSite(route.id, 'spread-b');
    const idleAlternative = await addChannelOnNewSite(route.id, 'spread-c');

    const selected = await new TokenRouter().selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      {
        channelLoad: (channelId: number) => {
          if (channelId === preferred.channel.id) return 1;
          if (channelId === busyAlternative.channel.id) return 5;
          return 0;
        },
      },
    );

    expect(selected?.channel.id).toBe(idleAlternative.channel.id);
  });

  it('prefers a different site among equally idle candidates', async () => {
    const route = await createRoute('spread-model');
    const preferred = await addChannelOnNewSite(route.id, 'spread-a');
    const sameSite = await addChannelToSite(route.id, preferred.site, 'spread-b');
    const offSite = await addChannelOnNewSite(route.id, 'spread-c');

    const selected = await new TokenRouter().selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      { channelLoad: (channelId: number) => (channelId === preferred.channel.id ? 2 : 0) },
    );

    // Both alternatives are idle; the hop must still avoid the preferred
    // channel's own site and never land back on the busy preferred channel.
    expect(selected?.channel.id).toBe(offSite.channel.id);
    expect(selected?.channel.id).not.toBe(sameSite.channel.id);
  });

  it('falls back to a same-site candidate when every other site is busy', async () => {
    const route = await createRoute('spread-model');
    const preferred = await addChannelOnNewSite(route.id, 'spread-a');
    const sameSite = await addChannelToSite(route.id, preferred.site, 'spread-b');
    const busyOffSite = await addChannelOnNewSite(route.id, 'spread-c');

    const selected = await new TokenRouter().selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      {
        channelLoad: (channelId: number) => {
          if (channelId === preferred.channel.id) return 2;
          if (channelId === busyOffSite.channel.id) return 6;
          return 0;
        },
      },
    );

    expect(selected?.channel.id).toBe(sameSite.channel.id);
    expect(selected?.channel.id).not.toBe(busyOffSite.channel.id);
  });

  it('picks the least-loaded alternative when every candidate is busy', async () => {
    const route = await createRoute('spread-model');
    const preferred = await addChannelOnNewSite(route.id, 'spread-a');
    const heavy = await addChannelOnNewSite(route.id, 'spread-b');
    const light = await addChannelOnNewSite(route.id, 'spread-c');
    const router = new TokenRouter();

    const heaviestFirst = await router.selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      {
        channelLoad: (channelId: number) => {
          if (channelId === preferred.channel.id) return 1;
          if (channelId === heavy.channel.id) return 5;
          return 9;
        },
      },
    );
    // The preferred channel's lower load must not pull the hop back onto it:
    // the spread target is chosen among the ALTERNATIVES.
    expect(heaviestFirst?.channel.id).toBe(heavy.channel.id);

    const lightestNext = await router.selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      {
        channelLoad: (channelId: number) => {
          if (channelId === preferred.channel.id) return 1;
          if (channelId === heavy.channel.id) return 5;
          return 2;
        },
      },
    );
    expect(lightestNext?.channel.id).toBe(light.channel.id);
  });

  it('returns null when the route has no other channel to spread to', async () => {
    const route = await createRoute('spread-model');
    const preferred = await addChannelOnNewSite(route.id, 'spread-a');

    const selected = await new TokenRouter().selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      { channelLoad: () => 1 },
    );

    expect(selected).toBeNull();
  });

  it('returns null when the preferred channel is not part of the eligible pool', async () => {
    const route = await createRoute('spread-model');
    await addChannelOnNewSite(route.id, 'spread-a');
    await addChannelOnNewSite(route.id, 'spread-b');

    const selected = await new TokenRouter().selectSpreadChannel(
      'spread-model',
      9_999,
      undefined,
      { channelLoad: () => 0 },
    );

    expect(selected).toBeNull();
  });

  it('skips a cooling alternative when a healthy one exists', async () => {
    const route = await createRoute('spread-model');
    const preferred = await addChannelOnNewSite(route.id, 'spread-a');
    const healthy = await addChannelOnNewSite(route.id, 'spread-b');
    const cooling = await addChannelOnNewSite(route.id, 'spread-c', {
      failCount: 4,
      lastFailAt: new Date().toISOString(),
    });

    const selected = await new TokenRouter().selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      { channelLoad: (channelId: number) => (channelId === preferred.channel.id ? 1 : 0) },
    );

    expect(selected?.channel.id).toBe(healthy.channel.id);
    expect(selected?.channel.id).not.toBe(cooling.channel.id);
  });

  it('refuses to spread when the only alternative is cooling down', async () => {
    const route = await createRoute('spread-model');
    const preferred = await addChannelOnNewSite(route.id, 'spread-a');
    await addChannelOnNewSite(route.id, 'spread-c', {
      failCount: 4,
      lastFailAt: new Date().toISOString(),
    });

    const selected = await new TokenRouter().selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      { channelLoad: (channelId: number) => (channelId === preferred.channel.id ? 1 : 0) },
    );

    expect(selected).toBeNull();
  });

  it('keeps the spread target inside the preferred channel priority layer', async () => {
    const route = await createRoute('spread-model');
    const preferred = await addChannelOnNewSite(route.id, 'spread-a', { priority: 0 });
    const sameLayer = await addChannelOnNewSite(route.id, 'spread-b', { priority: 0 });
    const backupLayer = await addChannelOnNewSite(route.id, 'spread-c', { priority: 5 });

    const selected = await new TokenRouter().selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      { channelLoad: (channelId: number) => (channelId === preferred.channel.id ? 1 : 0) },
    );

    expect(selected?.channel.id).toBe(sameLayer.channel.id);
    expect(selected?.channel.id).not.toBe(backupLayer.channel.id);
  });

  it('honors the per-request excluded channels', async () => {
    const route = await createRoute('spread-model');
    const preferred = await addChannelOnNewSite(route.id, 'spread-a');
    const excluded = await addChannelOnNewSite(route.id, 'spread-b');
    const usable = await addChannelOnNewSite(route.id, 'spread-c');
    const router = new TokenRouter();
    const loads = { channelLoad: (channelId: number) => (channelId === preferred.channel.id ? 1 : 0) };

    const withExclusion = await router.selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      { ...loads, excludeChannelIds: [excluded.channel.id] },
    );
    expect(withExclusion?.channel.id).toBe(usable.channel.id);

    const allExcluded = await router.selectSpreadChannel(
      'spread-model',
      preferred.channel.id,
      undefined,
      { ...loads, excludeChannelIds: [excluded.channel.id, usable.channel.id] },
    );
    expect(allExcluded).toBeNull();
  });
});
