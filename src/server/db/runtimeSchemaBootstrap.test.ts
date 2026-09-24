import baselineContractJson from './generated/fixtures/2026-03-14-baseline.schemaContract.json' with { type: 'json' };
import currentContractJson from './generated/schemaContract.json' with { type: 'json' };
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyLegacyCompatMutation } from './legacySchemaCompat.js';
import { generateBootstrapSql, generateUpgradeSql } from './schemaArtifactGenerator.js';
import type { SchemaContract, SchemaContractColumn } from './schemaContract.js';
import { describe, expect, it } from 'vitest';
import {
  __runtimeSchemaBootstrapTestUtils,
  ensureRuntimeDatabaseSchema,
  type RuntimeSchemaClient,
  type RuntimeSchemaDialect,
} from './runtimeSchemaBootstrap.js';

const baselineContract = baselineContractJson as unknown as SchemaContract;
const currentContract = currentContractJson as unknown as SchemaContract;

function createStubClient(dialect: RuntimeSchemaDialect, executedSql: string[]): RuntimeSchemaClient {
  return {
    dialect,
    connectionString: 'stub://localhost',
    ssl: false,
    begin: async () => {},
    commit: async () => {},
    rollback: async () => {},
    execute: async (sqlText: string) => {
      if (sqlText.trim().toLowerCase().startsWith('select')) {
        return [];
      }
      executedSql.push(sqlText);
      return [];
    },
    queryScalar: async (sqlText: string, params: unknown[] = []) => {
      if (sqlText.includes('information_schema') || sqlText.includes('sqlite_master') || sqlText.includes('pragma_table_info')) {
        return 1;
      }
      if (params.length > 0) {
        return 1;
      }
      return 0;
    },
    close: async () => {},
  };
}

function makeColumn(overrides: Partial<SchemaContractColumn> = {}): SchemaContractColumn {
  return {
    logicalType: 'text',
    notNull: false,
    defaultValue: null,
    primaryKey: false,
    ...overrides,
  };
}

describe('runtime schema bootstrap', () => {
  it.each(['mysql', 'postgres'] as const)('executes live-schema upgrade statements for %s', async (dialect) => {
    const executedSql: string[] = [];
    const expectedUpgradeSql = __runtimeSchemaBootstrapTestUtils.buildExternalUpgradeStatements(
      dialect,
      currentContract,
      baselineContract,
    );

    await ensureRuntimeDatabaseSchema(createStubClient(dialect, executedSql), {
      currentContract,
      liveContract: baselineContract as SchemaContract,
    });

    expect(executedSql.slice(0, expectedUpgradeSql.length)).toEqual(expectedUpgradeSql);
    // The additive upgrade statements come first and never drop anything; the
    // index replacement is the compat layer's job, which runs right after them.
    const dropStatements = executedSql.filter((sqlText) => sqlText.trim().toLowerCase().startsWith('drop index'));
    expect(dropStatements).toHaveLength(1);
    expect(dropStatements[0]).toContain('site_disabled_models_site_model_unique');
    expect(executedSql.indexOf(dropStatements[0]!)).toBeGreaterThanOrEqual(expectedUpgradeSql.length);
  });

  it('passes per-key disabled-model shim through the legacy compat guard and into a real sqlite database', async () => {
    // End-to-end guard for classifyLegacyCompatMutation: the compat layer runs
    // behind the mutation guard, so a non-whitelisted statement throws at boot
    // and the column never reaches a live database (the production bug was that
    // the whitelist hardcoded a `sites.` table prefix for all column specs).
    const dataDir = mkdtempSync(join(tmpdir(), 'metapi-legacy-compat-sqlite-'));
    const dbPath = join(dataDir, 'hub.db');
    const sqlite = new Database(dbPath);
    try {
      // Create the baseline schema (site_disabled_models without account_id).
      for (const statement of __runtimeSchemaBootstrapTestUtils.splitSqlStatements(
        generateBootstrapSql('sqlite', baselineContract),
      )) {
        if (!statement.trim()) continue;
        try { sqlite.exec(statement); } catch { /* skip non-replayable baseline statements */ }
      }

      const baselineColumns = sqlite.prepare("PRAGMA table_info('site_disabled_models')").all() as Array<{ name: string }>;
      expect(baselineColumns.some((column) => column.name === 'account_id')).toBe(false);

      const { ensureLegacySchemaCompatibility } = await import('./legacySchemaCompat.js');
      const inspector: import('./legacySchemaCompat.js').LegacySchemaCompatInspector = {
        dialect: 'sqlite',
        tableExists: async (table) => {
          return Number((sqlite.prepare('SELECT COUNT(*) FROM sqlite_master WHERE type = ? AND name = ?').get('table', table ?? '') as any)?.['COUNT(*)'] ?? 0) > 0;
        },
        columnExists: async (table, column) => {
          return Number((sqlite.prepare('SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?').get(table ?? '', column ?? '') as any)?.['COUNT(*)'] ?? 0) > 0;
        },
        execute: async (sqlText) => { sqlite.exec(sqlText); },
      };
      await ensureLegacySchemaCompatibility(inspector);

      const columns = sqlite.prepare("PRAGMA table_info('site_disabled_models')").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === 'account_id')).toBe(true);

      const indexes = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'site_disabled_models'")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((index) => index.name);
      expect(indexNames).toContain('site_disabled_models_site_account_model_unique');
      expect(indexNames).not.toContain('site_disabled_models_site_model_unique');
    } finally {
      sqlite.close();
    }
  });

  it('skips external schema execution when live schema already matches the current contract', async () => {
    const executedSql: string[] = [];
    const expectedUpgradeSql = __runtimeSchemaBootstrapTestUtils.buildExternalUpgradeStatements(
      'mysql',
      currentContract,
      currentContract,
    );

    await ensureRuntimeDatabaseSchema(createStubClient('mysql', executedSql), {
      currentContract,
      liveContract: currentContract as SchemaContract,
    });

    expect(expectedUpgradeSql).toEqual([]);
    expect(executedSql.every((sqlText) => classifyLegacyCompatMutation(sqlText) === 'legacy')).toBe(true);
  });

  it('tolerates non-additive live-schema drift and still emits additive runtime patch statements', () => {
    const driftedLiveContract = __runtimeSchemaBootstrapTestUtils.cloneContract(currentContract);

    delete driftedLiveContract.tables.model_availability?.columns.is_manual;
    if (driftedLiveContract.tables.sites?.columns.status) {
      driftedLiveContract.tables.sites.columns.status.defaultValue = null;
    }
    driftedLiveContract.indexes = driftedLiveContract.indexes.filter((index) => index.name !== 'accounts_site_id_idx');
    driftedLiveContract.uniques = driftedLiveContract.uniques.filter((unique) => unique.name !== 'proxy_files_public_id_unique');

    const statements = __runtimeSchemaBootstrapTestUtils.buildExternalUpgradeStatements(
      'mysql',
      currentContract,
      driftedLiveContract,
    );

    expect(statements.some((sqlText) => sqlText.includes('ALTER TABLE `model_availability` ADD COLUMN `is_manual`'))).toBe(true);
    expect(statements.some((sqlText) => sqlText.includes('CREATE INDEX `accounts_site_id_idx`'))).toBe(true);
    expect(statements.some((sqlText) => sqlText.includes('CREATE UNIQUE INDEX `proxy_files_public_id_unique`'))).toBe(true);
  });

  it('ignores duplicate mysql index and column errors when replaying additive schema statements', async () => {
    const executedSql: string[] = [];
    const duplicateColumnSql = __runtimeSchemaBootstrapTestUtils.splitSqlStatements(
      generateUpgradeSql('mysql', currentContract, baselineContract),
    ).find((sqlText) => sqlText.includes('ALTER TABLE `model_availability` ADD COLUMN `is_manual`'));
    const duplicateIndexSql = __runtimeSchemaBootstrapTestUtils.splitSqlStatements(
      generateUpgradeSql('mysql', currentContract, baselineContract),
    ).find((sqlText) => sqlText.includes('proxy_files_public_id_unique'));

    expect(duplicateColumnSql).toBeDefined();
    expect(duplicateIndexSql).toBeDefined();

    await ensureRuntimeDatabaseSchema({
      ...createStubClient('mysql', executedSql),
      execute: async (sqlText: string) => {
        executedSql.push(sqlText);
        if (sqlText === duplicateColumnSql) {
          const error = new Error("Duplicate column name 'is_manual'") as Error & { code?: string };
          error.code = 'ER_DUP_FIELDNAME';
          throw error;
        }
        if (sqlText === duplicateIndexSql) {
          const error = new Error("Duplicate key name 'model_availability_account_model_unique'") as Error & { code?: string };
          error.code = 'ER_DUP_KEYNAME';
          throw error;
        }
        return [];
      },
    }, {
      currentContract,
      liveContract: baselineContract as SchemaContract,
    });

    expect(executedSql).toContain(duplicateColumnSql);
    expect(executedSql).toContain(duplicateIndexSql);
  });

  it('ignores postgres relation-already-exists errors when replaying additive schema statements', async () => {
    const executedSql: string[] = [];
    const targetSql = __runtimeSchemaBootstrapTestUtils.splitSqlStatements(
      generateUpgradeSql('postgres', currentContract, baselineContract),
    ).find((sqlText) => sqlText.includes('proxy_files_public_id_unique'));

    expect(targetSql).toBeDefined();

    await ensureRuntimeDatabaseSchema({
      ...createStubClient('postgres', executedSql),
      execute: async (sqlText: string) => {
        executedSql.push(sqlText);
        if (sqlText === targetSql) {
          const error = new Error('relation "model_availability_account_model_unique" already exists') as Error & { code?: string };
          error.code = '42P07';
          throw error;
        }
        return [];
      },
    }, {
      currentContract,
      liveContract: baselineContract as SchemaContract,
    });

    expect(executedSql).toContain(targetSql);
  });

  it('adds mysql text prefixes for new indexes when live datetime-like columns are still stored as text', async () => {
    const executedSql: string[] = [];
    const minimalContract: SchemaContract = {
      tables: {
        proxy_logs: {
          columns: {
            downstream_api_key_id: makeColumn({ logicalType: 'integer' }),
            created_at: makeColumn({ logicalType: 'datetime', defaultValue: "datetime('now')" }),
          },
        },
      },
      indexes: [
        {
          name: 'proxy_logs_downstream_api_key_created_at_idx',
          table: 'proxy_logs',
          columns: ['downstream_api_key_id', 'created_at'],
          unique: false,
        },
      ],
      uniques: [],
      foreignKeys: [],
    };

    await ensureRuntimeDatabaseSchema({
      ...createStubClient('mysql', executedSql),
      execute: async (sqlText: string) => {
        if (sqlText.includes('FROM information_schema.columns')) {
          return [[
            {
              table_name: 'proxy_logs',
              column_name: 'downstream_api_key_id',
              data_type: 'int',
              column_type: 'int',
            },
            {
              table_name: 'proxy_logs',
              column_name: 'created_at',
              data_type: 'text',
              column_type: 'text',
            },
          ]];
        }

        executedSql.push(sqlText);
        return [];
      },
      queryScalar: async (sqlText: string, params: unknown[] = []) => {
        if (sqlText.includes('information_schema.tables')) {
          return params[0] === 'proxy_logs' ? 1 : 0;
        }
        if (sqlText.includes('information_schema.columns')) {
          return 1;
        }
        return 0;
      },
    }, {
      currentContract: minimalContract,
      liveContract: {
        ...minimalContract,
        indexes: [],
      },
    });

    expect(executedSql).toContain(
      'CREATE INDEX `proxy_logs_downstream_api_key_created_at_idx` ON `proxy_logs` (`downstream_api_key_id`, `created_at`(191))',
    );
  });

  it('does not add mysql text prefixes when live indexed text columns are varchar-backed', async () => {
    const executedSql: string[] = [];
    const minimalContract: SchemaContract = {
      tables: {
        sites: {
          columns: {
            platform: makeColumn({ logicalType: 'text', notNull: true }),
            url: makeColumn({ logicalType: 'text', notNull: true }),
          },
        },
      },
      indexes: [],
      uniques: [
        {
          name: 'sites_platform_url_unique',
          table: 'sites',
          columns: ['platform', 'url'],
        },
      ],
      foreignKeys: [],
    };

    await ensureRuntimeDatabaseSchema({
      ...createStubClient('mysql', executedSql),
      execute: async (sqlText: string) => {
        if (sqlText.includes('FROM information_schema.columns')) {
          return [[
            {
              table_name: 'sites',
              column_name: 'platform',
              data_type: 'varchar',
              column_type: 'varchar(32)',
            },
            {
              table_name: 'sites',
              column_name: 'url',
              data_type: 'varchar',
              column_type: 'varchar(255)',
            },
          ]];
        }

        executedSql.push(sqlText);
        return [];
      },
      queryScalar: async (sqlText: string, params: unknown[] = []) => {
        if (sqlText.includes('information_schema.tables')) {
          return params[0] === 'sites' ? 1 : 0;
        }
        if (sqlText.includes('information_schema.columns')) {
          return 1;
        }
        return 0;
      },
    }, {
      currentContract: minimalContract,
      liveContract: {
        ...minimalContract,
        uniques: [],
      },
    });

    expect(executedSql).toContain(
      'CREATE UNIQUE INDEX `sites_platform_url_unique` ON `sites` (`platform`, `url`)',
    );
    expect(executedSql).not.toContain(
      'CREATE UNIQUE INDEX `sites_platform_url_unique` ON `sites` (`platform`(191), `url`(191))',
    );
  });
});
