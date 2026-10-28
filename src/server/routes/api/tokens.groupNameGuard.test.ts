import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');

describe('POST/PUT /api/routes group-name guard', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedId = 0;

  const nextId = () => { seedId += 1; return seedId; }

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
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-route-group-guard-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;

    // The route handlers touch proxy/cache/billing subsystems on writes; the
    // module is imported dynamically below so each suite run gets a fresh
    // limiter state without a static-import reset dance.
    app = Fastify();
    const routesModule = await import('./tokens.js');
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    seedId = 0;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('refuses to create a second group with a name an enabled group already owns', async () => {
    const source = await insertExactRoute('claude-opus-4-6');
    const group = await insertGroup('claude-opus-4-6', [source.id]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'claude-opus-4-6',
        sourceRouteIds: [source.id],
      },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.conflictRouteId).toBe(group.id);
    expect(String(body.message)).toContain('已有群组');

    const rows = await db.select().from(schema.tokenRoutes).all();
    expect(rows).toHaveLength(2);
  });

  it('compares the alias, not the bytes (vendor prefix / case)', async () => {
    const source = await insertExactRoute('source-a');
    await insertGroup('Merged-X', [source.id]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: ' z-ai/MERGED-X:free ',
        sourceRouteIds: [source.id],
      },
    });

    expect(response.statusCode).toBe(409);
  });

  it('allows a group whose same-name twin is only an exact route', async () => {
    // The normal merge shape: the exact route exists, the group folds it in.
    const exact = await insertExactRoute('glm-5.3');

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'glm-5.3',
        sourceRouteIds: [exact.id],
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('allows taking over a name held only by a disabled group', async () => {
    const source = await insertExactRoute('source-b');
    await insertGroup('Retired-X', [source.id], false);

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'Retired-X',
        sourceRouteIds: [source.id],
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('refuses a rename into an owned name, and lets the owner edit itself', async () => {
    const source = await insertExactRoute('source-c');
    const owner = await insertGroup('Owned-X', [source.id]);
    const other = await insertGroup('Other-X', [source.id]);

    const blocked = await app.inject({
      method: 'PUT',
      url: `/api/routes/${other.id}`,
      payload: { displayName: 'owned-x' },
    });
    expect(blocked.statusCode).toBe(409);

    const selfEdit = await app.inject({
      method: 'PUT',
      url: `/api/routes/${owner.id}`,
      payload: { displayName: 'Owned-X', sourceRouteIds: [source.id] },
    });
    expect(selfEdit.statusCode).toBe(200);
  });

  it('leaves pattern-mode routes untouched by the guard', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: { routeMode: 'pattern', modelPattern: 're:^claude-.*$', displayName: 'any-name' },
    });
    expect(response.statusCode).toBe(200);
  });
});
