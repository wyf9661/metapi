import { eq, isNull, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

const STORED_TIMESTAMP_REPAIR_SETTING_KEY = 'stored_timestamp_repair_version';
const STORED_TIMESTAMP_REPAIR_VERSION = 1;

function normalizedCreatedAtSql(column: any) {
  return sql<string>`replace(substr(${column}, 1, 19), 'T', ' ')`;
}

export async function repairStoredCreatedAtValues(
  now = new Date(),
  options: { force?: boolean } = {},
): Promise<{ skipped: boolean }> {
  if (!options.force) {
    const marker = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, STORED_TIMESTAMP_REPAIR_SETTING_KEY))
      .get();
    let repairedVersion = 0;
    try {
      repairedVersion = Number(JSON.parse(String(marker?.value || '0')));
    } catch {}
    if (repairedVersion >= STORED_TIMESTAMP_REPAIR_VERSION) {
      return { skipped: true };
    }
  }

  const repairedAt = formatUtcSqlDateTime(now);

  await db.update(schema.events)
    .set({ createdAt: repairedAt })
    .where(or(isNull(schema.events.createdAt), eq(schema.events.createdAt, '')))
    .run();
  await db.update(schema.proxyLogs)
    .set({ createdAt: repairedAt })
    .where(or(isNull(schema.proxyLogs.createdAt), eq(schema.proxyLogs.createdAt, '')))
    .run();
  await db.update(schema.checkinLogs)
    .set({ createdAt: repairedAt })
    .where(or(isNull(schema.checkinLogs.createdAt), eq(schema.checkinLogs.createdAt, '')))
    .run();

  await db.update(schema.events)
    .set({ createdAt: normalizedCreatedAtSql(schema.events.createdAt) })
    .where(like(schema.events.createdAt, '%T%'))
    .run();
  await db.update(schema.proxyLogs)
    .set({ createdAt: normalizedCreatedAtSql(schema.proxyLogs.createdAt) })
    .where(like(schema.proxyLogs.createdAt, '%T%'))
    .run();
  await db.update(schema.checkinLogs)
    .set({ createdAt: normalizedCreatedAtSql(schema.checkinLogs.createdAt) })
    .where(like(schema.checkinLogs.createdAt, '%T%'))
    .run();

  await upsertSetting(STORED_TIMESTAMP_REPAIR_SETTING_KEY, STORED_TIMESTAMP_REPAIR_VERSION);
  return { skipped: false };
}
