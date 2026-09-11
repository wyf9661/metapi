import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';

/**
 * Cascade credential: the downstream key a MetAPI instance hands back to a
 * cascading peer that already holds its admin token.
 *
 * Reuse-first: every peer that presents the admin token shares one key named
 * `cascade`, so repeated site additions never pile up keys. The key carries
 * no limits (the peer is the same operator) and is enabled; if an operator
 * disabled or deleted it, a fresh one is issued on the next request.
 */
const CASCADE_KEY_NAME = 'cascade';

export function generateDownstreamSkKey(): string {
  return `sk-${randomBytes(24).toString('hex')}`;
}

export async function getOrCreateCascadeDownstreamKey(): Promise<string> {
  const rows = await db
    .select()
    .from(schema.downstreamApiKeys)
    .all();
  const existing = rows.find((row: any) => row.name === CASCADE_KEY_NAME);
  if (existing && existing.enabled !== false) {
    return existing.key;
  }

  const nowIso = new Date().toISOString();
  const inserted = await insertAndGetById<typeof schema.downstreamApiKeys.$inferSelect>({
    table: schema.downstreamApiKeys,
    idColumn: schema.downstreamApiKeys.id,
    values: {
      name: CASCADE_KEY_NAME,
      key: generateDownstreamSkKey(),
      description: 'Auto-issued for cascading MetAPI peers.',
      groupName: null,
      tags: JSON.stringify(['cascade']),
      enabled: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    insertErrorMessage: 'failed to issue cascade key',
    loadErrorMessage: 'failed to load cascade key',
  });
  if (existing) {
    // A disabled `cascade` row was replaced by a fresh enabled one.
    await db.delete(schema.downstreamApiKeys)
      .where(eq(schema.downstreamApiKeys.id, existing.id))
      .run();
  }
  return inserted.key;
}
