import { db, schema } from '../../db/index.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';

/**
 * Best-effort audit row for settings actions. Lives outside settings.ts so the
 * route modules split out of it (maintenance, database, backup) can record the
 * same event stream without importing the whole route file back.
 */
export async function appendSettingsEvent(input: {
  type: 'checkin' | 'balance' | 'proxy' | 'status' | 'token';
  title: string;
  message: string;
  level?: 'info' | 'warning' | 'error';
}) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    await db.insert(schema.events).values({
      type: input.type,
      title: input.title,
      message: input.message,
      level: input.level || 'info',
      relatedType: 'settings',
      createdAt,
    }).run();
  } catch { }
}
