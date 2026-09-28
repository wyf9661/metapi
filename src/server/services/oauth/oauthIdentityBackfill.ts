import { and, eq, isNull, like, or } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { buildOauthIdentityBackfillPatch } from './oauthAccount.js';

let inFlightOauthIdentityBackfill: Promise<number> | null = null;

async function runOauthIdentityBackfill(): Promise<number> {
  // Pre-filter in SQL to accounts that could need a patch: a missing structured
  // identity column AND a legacy `oauth` block in extra_config. That set is a
  // superset of "needs a patch" (the per-row predicate below parses the block
  // and requires a provider in it, and decides which columns are actually
  // empty), so the boot scan loads a few rows on a migrated database instead of
  // every account — API-key accounts have all three columns NULL and no oauth
  // block, so they no longer get loaded at all.
  const rows = await db.select().from(schema.accounts)
    .where(and(
      or(
        isNull(schema.accounts.oauthProvider),
        eq(schema.accounts.oauthProvider, ''),
        isNull(schema.accounts.oauthAccountKey),
        eq(schema.accounts.oauthAccountKey, ''),
        isNull(schema.accounts.oauthProjectId),
        eq(schema.accounts.oauthProjectId, ''),
      ),
      like(schema.accounts.extraConfig, '%"oauth"%'),
    ))
    .all();

  let updated = 0;
  for (const row of rows) {
    const patch = buildOauthIdentityBackfillPatch(row);
    if (!patch) continue;
    await db.update(schema.accounts).set({
      ...patch,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.accounts.id, row.id)).run();
    updated += 1;
  }

  return updated;
}

export async function ensureOauthIdentityBackfill(): Promise<number> {
  if (inFlightOauthIdentityBackfill) {
    return inFlightOauthIdentityBackfill;
  }

  inFlightOauthIdentityBackfill = (async () => {
    try {
      return await runOauthIdentityBackfill();
    } finally {
      inFlightOauthIdentityBackfill = null;
    }
  })();

  return inFlightOauthIdentityBackfill;
}
