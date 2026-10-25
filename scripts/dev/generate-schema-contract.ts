import { existsSync, readFileSync } from 'node:fs';
import { writeDialectArtifactFiles } from '../../src/server/db/schemaArtifactGenerator.js';
import {
  resolveGeneratedSchemaContractPath,
  type SchemaContract,
  writeSchemaContractFile,
} from '../../src/server/db/schemaContract.js';

function readPreviousSchemaContract(): SchemaContract | null {
  const contractPath = resolveGeneratedSchemaContractPath();
  if (!existsSync(contractPath)) {
    return null;
  }

  return JSON.parse(readFileSync(contractPath, 'utf8')) as SchemaContract;
}

const previousContract = readPreviousSchemaContract();
const contract = writeSchemaContractFile();
// Destructive schema edits (dropped tables/columns) are refused by default so a
// typo in schema.ts cannot silently become data loss. Set
// SCHEMA_ALLOW_DESTRUCTIVE=1 for a reviewed removal — the run then also emits
// the matching DROP statements into the upgrade artifacts.
const allowDestructive = process.env.SCHEMA_ALLOW_DESTRUCTIVE === '1';
writeDialectArtifactFiles(contract, previousContract, { allowDestructive });
const tableCount = Object.keys(contract.tables).length;

console.log(`[schema:contract] wrote ${tableCount} tables and dialect artifacts`);
