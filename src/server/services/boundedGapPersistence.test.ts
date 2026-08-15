import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { BoundedGapState } from './boundedGapSelection.js';

type DbModule = typeof import('../db/index.js');
type PersistenceModule = typeof import('./boundedGapPersistence.js');

const BOUNDED_GAP_STATE_SETTING_KEY = 'routing.bounded_gap_states';

describe('boundedGapPersistence', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let persistence: PersistenceModule;

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'metapi-bounded-gap-persist-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    persistence = await import('./boundedGapPersistence.js');

    db = dbModule.db;
    schema = dbModule.schema;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('persists and restores state with continuous sequence accounting', async () => {
    await persistence.__resetBoundedGapPersistenceForTests();
    const map = new Map<string, BoundedGapState>();
    map.set('model-a\u0000123', { sequence: 42, lastSelectedSequence: 30 });
    map.set('model-b\u0000456', { sequence: 42, lastSelectedSequence: null });
    persistence.attachBoundedGapStateMap(map);

    await persistence.persistBoundedGapStates();

    // Fresh module state: simulate a restart by loading from settings.
    await persistence.__resetBoundedGapPersistenceForTests();
    const restoredMap = new Map<string, BoundedGapState>();
    persistence.attachBoundedGapStateMap(restoredMap);
    await persistence.ensureBoundedGapStatesLoaded();

    expect(restoredMap.get('model-a\u0000123')).toEqual({ sequence: 42, lastSelectedSequence: 30 });
    expect(restoredMap.get('model-b\u0000456')).toEqual({ sequence: 42, lastSelectedSequence: null });
  });

  it('falls back to an empty map when no state was persisted', async () => {
    await persistence.__resetBoundedGapPersistenceForTests();
    await db.delete(schema.settings).where(eq(schema.settings.key, BOUNDED_GAP_STATE_SETTING_KEY)).run();

    const map = new Map<string, BoundedGapState>();
    persistence.attachBoundedGapStateMap(map);
    await persistence.ensureBoundedGapStatesLoaded();

    expect(map.size).toBe(0);
  });

  it('falls back to an empty map when the persisted payload is corrupt', async () => {
    await persistence.__resetBoundedGapPersistenceForTests();
    await db.delete(schema.settings).where(eq(schema.settings.key, BOUNDED_GAP_STATE_SETTING_KEY)).run();
    await db.insert(schema.settings).values({
      key: BOUNDED_GAP_STATE_SETTING_KEY,
      value: 'this is {not json',
    }).run();

    const map = new Map<string, BoundedGapState>();
    persistence.attachBoundedGapStateMap(map);
    await persistence.ensureBoundedGapStatesLoaded();

    expect(map.size).toBe(0);
  });

  it('falls back to an empty map when the persisted version is unknown', async () => {
    await persistence.__resetBoundedGapPersistenceForTests();
    await db.delete(schema.settings).where(eq(schema.settings.key, BOUNDED_GAP_STATE_SETTING_KEY)).run();
    await db.insert(schema.settings).values({
      key: BOUNDED_GAP_STATE_SETTING_KEY,
      value: JSON.stringify({
        version: 999,
        savedAtMs: Date.now(),
        states: { 'model-a\u0000123': { sequence: 1, lastSelectedSequence: null } },
      }),
    }).run();

    const map = new Map<string, BoundedGapState>();
    persistence.attachBoundedGapStateMap(map);
    await persistence.ensureBoundedGapStatesLoaded();

    expect(map.size).toBe(0);
  });

  it('skips malformed per-key entries while keeping valid ones', async () => {
    await persistence.__resetBoundedGapPersistenceForTests();
    await db.delete(schema.settings).where(eq(schema.settings.key, BOUNDED_GAP_STATE_SETTING_KEY)).run();
    await db.insert(schema.settings).values({
      key: BOUNDED_GAP_STATE_SETTING_KEY,
      value: JSON.stringify({
        version: 1,
        savedAtMs: Date.now(),
        states: {
          'model-valid\u00001': { sequence: 7, lastSelectedSequence: 2 },
          'model-bad\u00002': { sequence: 'not-a-number', lastSelectedSequence: 0 },
        },
      }),
    }).run();

    const map = new Map<string, BoundedGapState>();
    persistence.attachBoundedGapStateMap(map);
    await persistence.ensureBoundedGapStatesLoaded();

    expect(map.size).toBe(1);
    expect(map.get('model-valid\u00001')).toEqual({ sequence: 7, lastSelectedSequence: 2 });
  });
});
