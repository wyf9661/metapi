import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSqliteMigrations } from './db/migrate.js';
import {
  __runtimeDatabaseBootstrapTestUtils,
  ensureRuntimeDatabaseReady,
  runSqliteRuntimeMigrations,
} from './runtimeDatabaseBootstrap.js';

vi.mock('./db/migrate.js', () => ({
  runSqliteMigrations: vi.fn(),
}));

describe('runtimeDatabaseBootstrap', () => {
  beforeEach(() => {
    __runtimeDatabaseBootstrapTestUtils.resetSqliteMigrationsBootstrapped();
    vi.clearAllMocks();
  });

  it('runs sqlite migrations on the first runtime bootstrap call', async () => {
    await runSqliteRuntimeMigrations();

    expect(runSqliteMigrations).toHaveBeenCalledTimes(1);
  });

  it('runs sqlite runtime migrations when dialect is sqlite', async () => {
    const runSqliteRuntimeMigrations = vi.fn(async () => {});
    const ensureExternalRuntimeSchema = vi.fn(async () => {});

    await ensureRuntimeDatabaseReady({
      dialect: 'sqlite',
      runSqliteRuntimeMigrations,
      ensureExternalRuntimeSchema,
    });

    expect(runSqliteRuntimeMigrations).toHaveBeenCalledTimes(1);
    expect(ensureExternalRuntimeSchema).not.toHaveBeenCalled();
  });

  it.each(['postgres', 'mysql'] as const)('bootstraps external schema when dialect is %s', async (dialect) => {
    const runSqliteRuntimeMigrations = vi.fn(async () => {});
    const ensureExternalRuntimeSchema = vi.fn(async () => {});

    await ensureRuntimeDatabaseReady({
      dialect,
      runSqliteRuntimeMigrations,
      ensureExternalRuntimeSchema,
    });

    expect(ensureExternalRuntimeSchema).toHaveBeenCalledTimes(1);
    expect(runSqliteRuntimeMigrations).not.toHaveBeenCalled();
  });
});
