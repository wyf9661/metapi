import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { db, runtimeDbDialect, schema } from '../../db/index.js';
import { upsertSetting } from '../../db/upsertSetting.js';
import {
  maskConnectionString,
  migrateCurrentDatabase,
  normalizeMigrationInput,
  testDatabaseConnection,
  type MigrationDialect,
} from '../../services/databaseMigrationService.js';
import { parseDatabaseMigrationPayload } from '../../contracts/settingsRoutePayloads.js';
import { rejectTunnelAdminAction } from '../../tunnelAccessPolicy.js';
import { appendSettingsEvent } from './settingsShared.js';

/**
 * Runtime database configuration and migration endpoints, split out of
 * settingsRoutes. Registered by direct call so the Fastify encapsulation
 * context and auth hooks stay identical to the rest of the settings surface.
 */
type RuntimeDatabaseConfig = {
  dialect: MigrationDialect;
  connectionString: string;
  ssl: boolean;
};

const DB_TYPE_SETTING_KEY = 'db_type';
const DB_URL_SETTING_KEY = 'db_url';
const DB_SSL_SETTING_KEY = 'db_ssl';

function parseJsonValue(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function maskRuntimeConnection(dialect: MigrationDialect, connectionString: string): string {
  const normalized = connectionString.trim();
  if (dialect === 'sqlite' && !normalized) return '(default sqlite path)';
  return maskConnectionString(normalized);
}

async function loadSavedRuntimeDatabaseConfig(): Promise<RuntimeDatabaseConfig | null> {
  const settingsRows = await db.select().from(schema.settings).all();
  const map = new Map(settingsRows.map((row: any) => [row.key, row.value]));
  const rawDialect = parseJsonValue(map.get(DB_TYPE_SETTING_KEY));
  const rawConnection = parseJsonValue(map.get(DB_URL_SETTING_KEY));
  const rawSsl = parseJsonValue(map.get(DB_SSL_SETTING_KEY));
  if (typeof rawDialect !== 'string' || typeof rawConnection !== 'string') {
    return null;
  }

  try {
    const normalized = normalizeMigrationInput({
      dialect: rawDialect,
      connectionString: rawConnection,
      ssl: rawSsl,
    });
    return {
      dialect: normalized.dialect,
      connectionString: normalized.connectionString,
      ssl: normalized.ssl,
    };
  } catch {
    return null;
  }
}

function buildRuntimeDatabaseState(saved: RuntimeDatabaseConfig | null) {
  const activeDialect = runtimeDbDialect;
  const activeConnection = (config.dbUrl || '').trim();
  const activeSsl = config.dbSsl;
  const restartRequired = !!saved && (
    saved.dialect !== activeDialect ||
    saved.connectionString.trim() !== activeConnection ||
    saved.ssl !== activeSsl
  );

  return {
    active: {
      dialect: activeDialect,
      connection: maskRuntimeConnection(activeDialect, activeConnection),
      ssl: activeSsl,
    },
    saved: saved
      ? {
        dialect: saved.dialect,
        connection: maskRuntimeConnection(saved.dialect, saved.connectionString),
        ssl: saved.ssl,
      }
      : null,
    restartRequired,
  };
}

export function registerSettingsDatabaseRoutes(app: FastifyInstance): void {
  app.get('/api/settings/database/runtime', async () => {
    const saved = await loadSavedRuntimeDatabaseConfig();
    return {
      success: true,
      ...buildRuntimeDatabaseState(saved),
    };
  });

  app.put<{ Body: unknown }>('/api/settings/database/runtime', async (request, reply) => {
    if (rejectTunnelAdminAction(request, reply, '切换运行时数据库')) return reply;
    try {
      const parsedBody = parseDatabaseMigrationPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: parsedBody.error,
        });
      }

      const normalized = normalizeMigrationInput(parsedBody.data);
      await upsertSetting(DB_TYPE_SETTING_KEY, normalized.dialect);
      await upsertSetting(DB_URL_SETTING_KEY, normalized.connectionString);
      await upsertSetting(DB_SSL_SETTING_KEY, normalized.ssl);

      await appendSettingsEvent({
        type: 'status',
        title: '数据库运行配置已更新',
        message: `已保存运行数据库配置：${normalized.dialect}${normalized.ssl ? ' (SSL)' : ''}（重启后生效）`,
      });

      const saved: RuntimeDatabaseConfig = {
        dialect: normalized.dialect,
        connectionString: normalized.connectionString,
        ssl: normalized.ssl,
      };

      return {
        success: true,
        message: '数据库运行配置已保存，重启容器后生效',
        ...buildRuntimeDatabaseState(saved),
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        success: false,
        message: errMessage || '数据库运行配置保存失败',
      });
    }
  });

  app.post<{ Body: unknown }>('/api/settings/database/test-connection', async (request, reply) => {
    try {
      const parsedBody = parseDatabaseMigrationPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: parsedBody.error,
        });
      }

      const result = await testDatabaseConnection(parsedBody.data);
      return {
        success: true,
        message: '目标数据库连接成功',
        ...result,
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        success: false,
        message: errMessage || '数据库连接失败',
      });
    }
  });

  app.post<{ Body: unknown }>('/api/settings/database/migrate', async (request, reply) => {
    if (rejectTunnelAdminAction(request, reply, '迁移数据库')) return reply;
    try {
      const parsedBody = parseDatabaseMigrationPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: parsedBody.error,
        });
      }

      const result = await migrateCurrentDatabase(parsedBody.data);
      appendSettingsEvent({
        type: 'status',
        title: '数据库迁移已完成',
        message: `目标 ${result.dialect}，已迁移站点 ${result.rows.sites}、账号 ${result.rows.accounts}、令牌 ${result.rows.accountTokens}、路由 ${result.rows.tokenRoutes}、通道 ${result.rows.routeChannels}、设置 ${result.rows.settings}`,
      });
      return {
        success: true,
        message: '数据库迁移完成',
        ...result,
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        success: false,
        message: errMessage || '数据库迁移失败',
      });
    }
  });
}
