import baselineContractJson from './generated/fixtures/2026-03-14-baseline.schemaContract.json' with { type: 'json' };
import currentContractJson from './generated/schemaContract.json' with { type: 'json' };
import { applyContractFixtureThenUpgrade, introspectLiveSchema } from './schemaIntrospection.js';
import type { SchemaContract } from './schemaContract.js';
import { describe, expect, it } from 'vitest';

const baselineContract = baselineContractJson as unknown as SchemaContract;
const currentContract = currentContractJson as unknown as SchemaContract;

const skipLiveSchema = process.env.DB_PARITY_SKIP_LIVE_SCHEMA === 'true';

// Introspection returns foreign keys in creation order, which depends on the
// order migrations created them, so compare them as a set.
const foreignKeySortKey = (entry: { table: string; columns: string[]; referencedTable: string; referencedColumns: string[] }) =>
  `${entry.table}|${entry.columns.join(',')}|${entry.referencedTable}|${entry.referencedColumns.join(',')}`;

function withSortedForeignKeys(contract: SchemaContract): SchemaContract {
  return { ...contract, foreignKeys: [...contract.foreignKeys].sort((a, b) => foreignKeySortKey(a).localeCompare(foreignKeySortKey(b))) };
}
const sqliteUpgrade = !skipLiveSchema && process.env.DB_PARITY_SQLITE !== 'false' ? it : it.skip;
const mysqlUpgrade = process.env.DB_PARITY_MYSQL_URL ? it : it.skip;
const postgresUpgrade = process.env.DB_PARITY_POSTGRES_URL ? it : it.skip;

describe('schema upgrade parity', () => {
  sqliteUpgrade('upgrades sqlite to the current contract', async () => {
    const sqliteUrl = await applyContractFixtureThenUpgrade('sqlite', baselineContract, currentContract);
    const live = await introspectLiveSchema({ dialect: 'sqlite', connectionString: sqliteUrl });
    expect(withSortedForeignKeys(live)).toEqual(withSortedForeignKeys(currentContract));
  });

  mysqlUpgrade('upgrades mysql to the current contract', async () => {
    const mysqlUrl = await applyContractFixtureThenUpgrade('mysql', baselineContract, currentContract, {
      connectionString: process.env.DB_PARITY_MYSQL_URL!,
    });
    const live = await introspectLiveSchema({ dialect: 'mysql', connectionString: mysqlUrl });
    expect(withSortedForeignKeys(live)).toEqual(withSortedForeignKeys(currentContract));
  }, 60_000);

  postgresUpgrade('upgrades postgres to the current contract', async () => {
    const postgresUrl = await applyContractFixtureThenUpgrade('postgres', baselineContract, currentContract, {
      connectionString: process.env.DB_PARITY_POSTGRES_URL!,
    });
    const live = await introspectLiveSchema({ dialect: 'postgres', connectionString: postgresUrl });
    expect(withSortedForeignKeys(live)).toEqual(withSortedForeignKeys(currentContract));
  }, 60_000);
});
