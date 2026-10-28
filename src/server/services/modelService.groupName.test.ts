import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('rebuildTokenRoutesFromAvailability vs explicit group names', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let rebuildTokenRoutesFromAvailability: ModelServiceModule['rebuildTokenRoutesFromAvailability'];
  let dataDir = '';
  let seedId = 0;

  const seedAccountModel = async (modelName: string) => {
    seedId += 1;
    const site = await db.insert(schema.sites).values({
      name: `site-${seedId}`,
      url: `https://site-${seedId}.example.com`,
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${seedId}`,
      accessToken: '',
      apiToken: '***',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName,
      available: true,
      latencyMs: 900,
    }).run();
  };

  const insertExactRoute = async (modelPattern: string) => db.insert(schema.tokenRoutes).values({
    modelPattern,
    enabled: true,
  }).returning().get();

  const insertGroup = async (exposedName: string, sourceRouteIds: number[], enabled = true) => {
    const group = await db.insert(schema.tokenRoutes).values({
      modelPattern: exposedName,
      displayName: exposedName,
      routeMode: 'explicit_group',
      enabled,
    }).returning().get();
    if (sourceRouteIds.length > 0) {
      await db.insert(schema.routeGroupSources).values(
        sourceRouteIds.map((sourceRouteId) => ({ groupRouteId: group.id, sourceRouteId })),
      ).run();
    }
    return group;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-service-groupnames-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    rebuildTokenRoutesFromAvailability = modelService.rebuildTokenRoutesFromAvailability;
  });

  beforeEach(async () => {
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    seedId = 0;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('does not create a second route when an enabled group already owns the name', async () => {
    await seedAccountModel('source-a');
    await seedAccountModel('merged-x');
    const sourceA = await insertExactRoute('source-a');
    const group = await insertGroup('merged-x', [sourceA.id]);

    await rebuildTokenRoutesFromAvailability();

    const sameName = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'merged-x'))
      .all();
    expect(sameName).toHaveLength(1);
    expect(sameName[0]!.id).toBe(group.id);
  });

  it('matches the owned name through alias canonicalization, not byte equality', async () => {
    // Availability offers a vendor-prefixed :free name; the group's public
    // name was typed by hand in a different shape. Both canonicalize to the
    // same alias the router already treats as one model, so the rebuild must
    // not fork a second card under the normalized name.
    await seedAccountModel('source-a');
    await seedAccountModel('z-ai/Merged-X:free');
    const source = await insertExactRoute('source-a');
    const group = await insertGroup('Merged-X', [source.id]);

    await rebuildTokenRoutesFromAvailability();

    const groupRows = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.routeMode, 'explicit_group'))
      .all();
    expect(groupRows).toHaveLength(1);
    expect(groupRows[0]!.id).toBe(group.id);
    const allRoutes = await db.select().from(schema.tokenRoutes).all();
    // source + group only; no third row for the same alias.
    expect(allRoutes).toHaveLength(2);
  });

  it('still creates the exact route when the owning group is disabled', async () => {
    await seedAccountModel('merged-y');
    await insertGroup('merged-y', [], false);

    await rebuildTokenRoutesFromAvailability();

    const rows = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'merged-y'))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.some((route: any) => route.routeMode !== 'explicit_group')).toBe(true);
  });

  it('still creates the exact route when the enabled group holds no sources', async () => {
    // Recovery path: every source route died upstream, the group's bindings
    // cascaded away, the name is orphaned. Losing the model to an empty shell
    // is worse than the twin-card problem the guard exists for.
    await seedAccountModel('merged-z');
    await insertGroup('merged-z', []);

    await rebuildTokenRoutesFromAvailability();

    const rows = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'merged-z'))
      .all();
    expect(rows).toHaveLength(2);
  });

  it('leaves plain models untouched', async () => {
    await seedAccountModel('plain-model');
    await rebuildTokenRoutesFromAvailability();
    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.modelPattern, 'plain-model'))
      .get();
    expect(route).toBeDefined();
    expect(route?.routeMode).not.toBe('explicit_group');
  });
});
