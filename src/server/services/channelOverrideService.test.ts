import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ChannelOverrideServiceModule = typeof import('./channelOverrideService.js');

describe('resetChannelToDerivedState', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let resetChannelToDerivedState: ChannelOverrideServiceModule['resetChannelToDerivedState'];
  let dataDir = '';
  let seedId = 0;

  const nextId = () => {
    seedId += 1;
    return seedId;
  };

  const seedAccount = async () => {
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
    return { site, account };
  };

  const seedToken = async (accountId: number, modelName: string, label: string, isDefault: boolean) => {
    const id = nextId();
    const token = await db.insert(schema.accountTokens).values({
      accountId,
      name: label,
      token: `sk-${label}-${id}`,
      enabled: true,
      isDefault,
    }).returning().get();
    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName,
      available: true,
    }).run();
    return token;
  };

  const seedPatternRoute = async (modelPattern: string) => {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();
    return route;
  };

  const accumulatedStats = {
    successCount: 12,
    failCount: 1,
    totalCost: 0.4,
    totalLatencyMs: 2_400,
    lastUsedAt: '2026-09-25T10:00:00.000Z',
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-channel-override-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./channelOverrideService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    resetChannelToDerivedState = serviceModule.resetChannelToDerivedState;
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

  it('restores the derived values, clears the manual flag, and keeps the row id + stats', async () => {
    const { account } = await seedAccount();
    const token = await seedToken(account.id, 'gpt-4o', 'primary', true);
    const route = await seedPatternRoute('re:^gpt-4o.*$');

    const manual = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'gpt-4o-hand-picked',
      priority: 7,
      weight: 33,
      enabled: true,
      manualOverride: true,
      requestOverrideRules: JSON.stringify([{ op: 'replace', path: '/max_tokens', value: 42 }]),
    }).returning().get();
    await db.update(schema.routeChannels)
      .set(accumulatedStats)
      .where(eq(schema.routeChannels.id, manual.id))
      .run();

    const result = await resetChannelToDerivedState(manual.id);

    expect(result.reset).toBe(true);
    expect(result.derived).toBe(true);
    expect(result.channel).toMatchObject({
      id: manual.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'gpt-4o',
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
      requestOverrideRules: null,
      ...accumulatedStats,
    });
  });

  it('rebinds to the account preferred token when a non-default token was bound manually', async () => {
    const { account } = await seedAccount();
    const fallback = await seedToken(account.id, 'gpt-4o', 'secondary', false);
    const preferred = await seedToken(account.id, 'gpt-4o', 'primary', true);
    const route = await seedPatternRoute('re:^gpt-4o.*$');

    const manual = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: fallback.id,
      sourceModel: 'gpt-4o',
      priority: 3,
      weight: 10,
      enabled: true,
      manualOverride: true,
    }).returning().get();
    await db.update(schema.routeChannels)
      .set(accumulatedStats)
      .where(eq(schema.routeChannels.id, manual.id))
      .run();

    const result = await resetChannelToDerivedState(manual.id);

    expect(result.reset).toBe(true);
    expect(result.channel).toMatchObject({
      id: manual.id,
      tokenId: preferred.id,
      manualOverride: false,
      ...accumulatedStats,
    });
  });

  it('leaves the row untouched when no derivable default exists for it', async () => {
    const { account } = await seedAccount();
    const route = await seedPatternRoute('re:^zzz-nowhere.*$');

    const manual = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      sourceModel: 'zzz-nowhere-hand-added',
      priority: 5,
      weight: 20,
      enabled: true,
      manualOverride: true,
    }).returning().get();
    await db.update(schema.routeChannels)
      .set(accumulatedStats)
      .where(eq(schema.routeChannels.id, manual.id))
      .run();

    const result = await resetChannelToDerivedState(manual.id);

    expect(result.reset).toBe(false);
    expect(result.derived).toBe(false);

    const after = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, manual.id))
      .get();
    expect(after).toMatchObject({
      sourceModel: 'zzz-nowhere-hand-added',
      priority: 5,
      weight: 20,
      manualOverride: true,
      ...accumulatedStats,
    });
  });

  it('returns reset=false for a nonexistent channel', async () => {
    const result = await resetChannelToDerivedState(999_999);
    expect(result.reset).toBe(false);
    expect(result.derived).toBe(false);
  });
});