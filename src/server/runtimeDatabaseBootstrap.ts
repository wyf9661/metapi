import {
  bootstrapRuntimeDatabaseSchema,
  type RuntimeSchemaDialect,
} from './db/runtimeSchemaBootstrap.js';

let sqliteMigrationsBootstrapped = false;

export async function runSqliteRuntimeMigrations(): Promise<void> {
  const migrateModule = await import('./db/migrate.js');
  if (!sqliteMigrationsBootstrapped) {
    sqliteMigrationsBootstrapped = true;
  }
  migrateModule.runSqliteMigrations();
}

type EnsureRuntimeDatabaseReadyInput = {
  dialect: RuntimeSchemaDialect;
  connectionString?: string;
  ssl?: boolean;
  runSqliteRuntimeMigrations?: () => Promise<void>;
  ensureExternalRuntimeSchema?: () => Promise<void>;
};

export async function ensureRuntimeDatabaseReady(input: EnsureRuntimeDatabaseReadyInput): Promise<void> {
  if (input.dialect === 'sqlite') {
    const runSqlite = input.runSqliteRuntimeMigrations || runSqliteRuntimeMigrations;
    await runSqlite();
    return;
  }

  const ensureExternal = input.ensureExternalRuntimeSchema || (async () => {
    const connectionString = (input.connectionString || '').trim();
    if (!connectionString) {
      throw new Error(`DB_URL is required when DB_TYPE=${input.dialect}`);
    }
    await bootstrapRuntimeDatabaseSchema({
      dialect: input.dialect,
      connectionString,
      ssl: !!input.ssl,
    });
  });

  await ensureExternal();
}

export const __runtimeDatabaseBootstrapTestUtils = {
  resetSqliteMigrationsBootstrapped() {
    sqliteMigrationsBootstrapped = false;
  },
};
