import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type PatternRouteChannelSyncServiceModule = typeof import('./patternRouteChannelSyncService.js');

describe('rebuildAutomaticRouteChannelsByModelPattern preserves channel rows and stats', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let rebuildAutomaticRouteChannelsByModelPattern: PatternRouteChannelSyncServiceModule['rebuildAutomaticRouteChannelsByModelPattern'];
  let dataDir = '';
  let seedId = 0;

  const nextId = () => {
    seedId += 1;
    return seedId;
  };

  const seedAccountWithToken = async (modelName: string) => {
    const id = nextId();
    const site = await db.insert(schema.sites).values({
      name: `site-${id}`,
      url: `https://example.com/${id}`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${id}`,
      accessToken: `access-${id}`,
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `token-${id}`,
      token: `sk-token-${id}`,
      enabled: true,
      isDefault: true,
    }).returning().get();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName,
      available: true,
    }).run();

    return { site, account, token };
  };

  const listChannels = async (routeId: number) => db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.routeId, routeId))
    .all();

  const accumulatedStats = {
    successCount: 42,
    failCount: 3,
    totalCost: 1.25,
    totalLatencyMs: 9_000,
    lastUsedAt: '2026-09-20T10:00:00.000Z',
    lastSelectedAt: '2026-09-20T09:59:00.000Z',
    lastFailAt: '2026-09-19T08:00:00.000Z',
    cooldownLevel: 2,
    cooldownUntil: '2026-09-20T10:05:00.000Z',
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-pattern-sync-preserve-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./patternRouteChannelSyncService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    rebuildAutomaticRouteChannelsByModelPattern = serviceModule.rebuildAutomaticRouteChannelsByModelPattern;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    seedId = 0;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('keeps the same channel row (id + accumulated stats) across a rebuild', async () => {
    const seeded = await seedAccountWithToken('gpt-4o');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^gpt-4o.*$',
      enabled: true,
    }).returning().get();

    await rebuildAutomaticRouteChannelsByModelPattern(route.id, route.modelPattern);
    const created = await listChannels(route.id);
    expect(created).toHaveLength(1);

    await db.update(schema.routeChannels)
      .set(accumulatedStats)
      .where(eq(schema.routeChannels.id, created[0].id))
      .run();

    const result = await rebuildAutomaticRouteChannelsByModelPattern(route.id, route.modelPattern);

    const after = await listChannels(route.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(created[0].id);
    expect(after[0]).toMatchObject({
      accountId: seeded.account.id,
      tokenId: seeded.token.id,
      sourceModel: 'gpt-4o',
      ...accumulatedStats,
    });
    expect(result.removedChannels).toBe(0);
    expect(result.createdChannels).toBe(0);
  });

  it('re-keys the same row in place when the account token is replaced', async () => {
    const seeded = await seedAccountWithToken('gpt-4o');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^gpt-4o.*$',
      enabled: true,
    }).returning().get();

    await rebuildAutomaticRouteChannelsByModelPattern(route.id, route.modelPattern);
    const created = await listChannels(route.id);
    expect(created).toHaveLength(1);
    await db.update(schema.routeChannels)
      .set(accumulatedStats)
      .where(eq(schema.routeChannels.id, created[0].id))
      .run();

    // The account's key gets rotated: old token row disappears, a new one takes its place.
    await db.delete(schema.accountTokens).where(eq(schema.accountTokens.id, seeded.token.id)).run();
    const replacement = await db.insert(schema.accountTokens).values({
      accountId: seeded.account.id,
      name: 'token-replacement',
      token: 'sk-token-replacement',
      enabled: true,
      isDefault: true,
    }).returning().get();
    await db.insert(schema.tokenModelAvailability).values({
      tokenId: replacement.id,
      modelName: 'gpt-4o',
      available: true,
    }).run();

    const result = await rebuildAutomaticRouteChannelsByModelPattern(route.id, route.modelPattern);

    const after = await listChannels(route.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(created[0].id);
    expect(after[0]).toMatchObject({
      accountId: seeded.account.id,
      tokenId: replacement.id,
      sourceModel: 'gpt-4o',
      ...accumulatedStats,
    });
    expect(result.updatedChannels).toBe(1);
    expect(result.removedChannels).toBe(0);
    expect(result.createdChannels).toBe(0);
  });

  it('still removes channels that are no longer desired', async () => {
    const seeded = await seedAccountWithToken('gpt-4o');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^gpt-4o.*$',
      enabled: true,
    }).returning().get();

    await rebuildAutomaticRouteChannelsByModelPattern(route.id, route.modelPattern);
    expect(await listChannels(route.id)).toHaveLength(1);

    await db.update(schema.tokenModelAvailability)
      .set({ available: false })
      .where(eq(schema.tokenModelAvailability.tokenId, seeded.token.id))
      .run();

    const result = await rebuildAutomaticRouteChannelsByModelPattern(route.id, route.modelPattern);

    expect(await listChannels(route.id)).toHaveLength(0);
    expect(result.removedChannels).toBe(1);
  });

  it('never touches manually overridden channels', async () => {
    const seeded = await seedAccountWithToken('gpt-4o');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^gpt-4o.*$',
      enabled: true,
    }).returning().get();

    const manual = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: seeded.account.id,
      tokenId: seeded.token.id,
      sourceModel: 'gpt-4o-pinned',
      priority: 7,
      weight: 33,
      enabled: true,
      manualOverride: true,
    }).returning().get();
    await db.update(schema.routeChannels)
      .set(accumulatedStats)
      .where(eq(schema.routeChannels.id, manual.id))
      .run();

    await rebuildAutomaticRouteChannelsByModelPattern(route.id, route.modelPattern);

    const after = await listChannels(route.id);
    const manualAfter = after.find((channel: any) => channel.id === manual.id);
    expect(manualAfter).toMatchObject({
      sourceModel: 'gpt-4o-pinned',
      priority: 7,
      weight: 33,
      manualOverride: true,
      ...accumulatedStats,
    });
    // The derived channel for the same account+model is still created alongside it.
    expect(after.filter((channel: any) => channel.manualOverride === false)).toHaveLength(1);
  });
});
