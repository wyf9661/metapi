import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./sensitiveWordDetectionService.js');

describe('sensitive word detection service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sensitive-word-'));
    process.env.DATA_DIR = dataDir;
    // Load db + service AFTER DATA_DIR is set so the module singleton binds
    // to this test's temp database (loading earlier would cache the default
    // DATA_DIR path).
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./sensitiveWordDetectionService.js');
    service.__resetSensitiveWordDetectionCacheForTests();
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
    service.__resetSensitiveWordDetectionCacheForTests();
  });

  describe('clampAntiProbeMinTextLength', () => {
    it('clamps to 1..64 and truncates', () => {
      expect(service.clampAntiProbeMinTextLength(5)).toBe(5);
      expect(service.clampAntiProbeMinTextLength(0)).toBe(1);
      expect(service.clampAntiProbeMinTextLength(-3)).toBe(1);
      expect(service.clampAntiProbeMinTextLength(999)).toBe(64);
      expect(service.clampAntiProbeMinTextLength(8.7)).toBe(8);
    });

    it('falls back to default for non-finite values', () => {
      expect(service.clampAntiProbeMinTextLength(Number.NaN)).toBe(8);
      expect(service.clampAntiProbeMinTextLength(Number.POSITIVE_INFINITY)).toBe(8);
    });
  });

  describe('settings (DB-backed)', () => {
    it('defaults to enabled with min length 8', async () => {
      expect(await service.resolveGlobalSensitiveWordDetection()).toBe(true);
      expect(await service.resolveAntiProbeMinTextLength()).toBe(8);
    });

    it('persists and resolves overrides', async () => {
      await service.setGlobalSensitiveWordDetection(false);
      expect(await service.resolveGlobalSensitiveWordDetection()).toBe(false);
      // Cache is still warm; clear it to prove persistence, not cache.
      service.__resetSensitiveWordDetectionCacheForTests();
      expect(await service.resolveGlobalSensitiveWordDetection()).toBe(false);

      await service.setAntiProbeMinTextLength(12);
      service.__resetSensitiveWordDetectionCacheForTests();
      expect(await service.resolveAntiProbeMinTextLength()).toBe(12);
    });

    it('clamps stored values on read', async () => {
      await service.setAntiProbeMinTextLength(999);
      service.__resetSensitiveWordDetectionCacheForTests();
      expect(await service.resolveAntiProbeMinTextLength()).toBe(64);
    });

    it('writes the settings rows into the settings table', async () => {
      await service.setGlobalSensitiveWordDetection(true);
      await service.setAntiProbeMinTextLength(10);
      const enabledRow = await db.select().from(schema.settings)
        .where(eq(schema.settings.key, 'sensitiveWordDetectionEnabled')).get();
      expect(enabledRow?.value).toBe(JSON.stringify(true));
      const lenRow = await db.select().from(schema.settings)
        .where(eq(schema.settings.key, 'antiProbeMinTextLength')).get();
      expect(lenRow?.value).toBe(JSON.stringify(10));
    });
  });
});
