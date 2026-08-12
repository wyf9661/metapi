import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

type DbModule = typeof import('./index.js');

describe('db switch drain', () => {
  let testUtils: DbModule['__dbProxyTestUtils'];
  let dbModule: DbModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-db-drain-'));
    await import('./migrate.js');
    dbModule = await import('./index.js');
    testUtils = dbModule.__dbProxyTestUtils;
    testUtils.resetDbDrainStateForTests();
  });

  afterAll(() => {
    testUtils.resetDbDrainStateForTests();
    delete process.env.DATA_DIR;
  });

  it('isDbSwitching starts false', () => {
    expect(testUtils.isDbSwitching()).toBe(false);
    expect(testUtils.getDbInFlightQueries()).toBe(0);
  });

  it('normal queries increment and decrement the in-flight counter', async () => {
    await dbModule.db.select().from(dbModule.schema.sites).all();
    // Counter returns to 0 after the query completes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(testUtils.getDbInFlightQueries()).toBe(0);
  });

  it('queries issued while switching wait until the switch flag clears', async () => {
    testUtils.resetDbDrainStateForTests();
    testUtils.setDbSwitchingForTests(true);

    // Fire a query while "switching" — it must not throw; it should wait.
    const queryPromise = dbModule.db.select().from(dbModule.schema.sites).all();

    // Give the query a tick to reach the acquire gate.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Clearing the switch flag releases the waiter.
    testUtils.setDbSwitchingForTests(false);
    testUtils.resetDbDrainStateForTests();

    const rows = await queryPromise;
    expect(Array.isArray(rows)).toBe(true);
  });

  it('switchRuntimeDatabase switches between sqlite paths and drains cleanly', async () => {
    testUtils.resetDbDrainStateForTests();
    const secondDataDir = mkdtempSync(join(tmpdir(), 'metapi-db-drain-second-'));
    const secondDbPath = join(secondDataDir, 'metapi.db');

    await expect(
      dbModule.switchRuntimeDatabase('sqlite', secondDbPath),
    ).resolves.toBeUndefined();

    // After the switch the db still works against the new path.
    await dbModule.db.insert(dbModule.schema.sites).values({
      name: 'drain-test',
      url: 'https://drain-test.example.com',
      platform: 'new-api',
      status: 'active',
    }).run();
    const rows = await dbModule.db.select().from(dbModule.schema.sites).all();
    expect(rows.length).toBe(1);

    // Restore a fresh sqlite instance so other tests in the file stay isolated.
    testUtils.resetDbDrainStateForTests();
    await dbModule.switchRuntimeDatabase('sqlite', join(mkdtempSync(join(tmpdir(), 'metapi-db-drain-restore-')), 'metapi.db'));
  });
});