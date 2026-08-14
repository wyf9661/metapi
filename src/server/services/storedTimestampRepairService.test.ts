import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type RepairModule = typeof import('./storedTimestampRepairService.js');

describe('storedTimestampRepairService', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let repairStoredCreatedAtValues: RepairModule['repairStoredCreatedAtValues'];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-timestamp-repair-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const repairModule = await import('./storedTimestampRepairService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    repairStoredCreatedAtValues = repairModule.repairStoredCreatedAtValues;
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    await db.delete(schema.events).run();
  });

  afterAll(async () => {
    await closeDbConnections();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('repairs legacy timestamps once and skips later startup calls', async () => {
    const inserted = await db.insert(schema.events).values({
      type: 'test',
      title: 'legacy',
      message: 'legacy',
      createdAt: '2026-08-14T01:02:03.456Z',
    }).returning({ id: schema.events.id }).get();

    await expect(repairStoredCreatedAtValues(new Date('2026-08-14T05:00:00Z')))
      .resolves.toEqual({ skipped: false });
    const repaired = await db.select().from(schema.events).where(eq(schema.events.id, inserted.id)).get();
    expect(repaired?.createdAt).toBe('2026-08-14 01:02:03');

    await db.update(schema.events)
      .set({ createdAt: '2026-08-14T02:03:04.000Z' })
      .where(eq(schema.events.id, inserted.id))
      .run();
    await expect(repairStoredCreatedAtValues(new Date('2026-08-14T06:00:00Z')))
      .resolves.toEqual({ skipped: true });
    const skipped = await db.select().from(schema.events).where(eq(schema.events.id, inserted.id)).get();
    expect(skipped?.createdAt).toBe('2026-08-14T02:03:04.000Z');
  });

  it('supports forced repairs for explicit maintenance and tests', async () => {
    const inserted = await db.insert(schema.events).values({
      type: 'test',
      title: 'forced',
      message: 'forced',
      createdAt: '2026-08-14T03:04:05.000Z',
    }).returning({ id: schema.events.id }).get();

    await repairStoredCreatedAtValues(new Date(), { force: true });
    const repaired = await db.select().from(schema.events).where(eq(schema.events.id, inserted.id)).get();
    expect(repaired?.createdAt).toBe('2026-08-14 03:04:05');
  });
});
