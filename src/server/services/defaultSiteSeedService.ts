import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';

export const DEFAULT_SITE_SEED_SETTING_KEY = 'default_site_seed_v1';

const DEFAULT_SITE_ROWS: Array<typeof schema.sites.$inferInsert> = [];

type SeedSummary = {
  seeded: number;
  alreadyMarked: boolean;
  hadExistingSites: boolean;
};

async function writeSeedMarker(tx: typeof db) {
  await upsertSetting(DEFAULT_SITE_SEED_SETTING_KEY, true, tx);
}

// Fork policy: do not auto-insert official/OAuth demo sites on install.
// Only write the seed marker so upgrades never re-seed later.
export async function ensureDefaultSitesSeeded(): Promise<SeedSummary> {
  return db.transaction(async (tx) => {
    const marker = await tx.select({ key: schema.settings.key })
      .from(schema.settings)
      .where(eq(schema.settings.key, DEFAULT_SITE_SEED_SETTING_KEY))
      .get();

    if (marker) {
      return {
        seeded: 0,
        alreadyMarked: true,
        hadExistingSites: false,
      };
    }

    const existingSite = await tx.select({ id: schema.sites.id })
      .from(schema.sites)
      .limit(1)
      .get();

    if (existingSite) {
      await writeSeedMarker(tx);
      return {
        seeded: 0,
        alreadyMarked: false,
        hadExistingSites: true,
      };
    }

    if (DEFAULT_SITE_ROWS.length > 0) {
      await tx.insert(schema.sites).values(DEFAULT_SITE_ROWS).run();
    }
    await writeSeedMarker(tx);
    return {
      seeded: DEFAULT_SITE_ROWS.length,
      alreadyMarked: false,
      hadExistingSites: false,
    };
  });
}
