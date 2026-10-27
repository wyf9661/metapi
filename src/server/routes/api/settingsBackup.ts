import type { FastifyInstance } from 'fastify';
import {
  exportBackup,
  exportBackupToWebdav,
  getBackupWebdavConfig,
  importBackup,
  importBackupFromWebdav,
  reloadBackupWebdavScheduler,
  saveBackupWebdavConfig,
  type BackupExportType,
} from '../../services/backupService.js';
import {
  parseBackupImportPayload,
  parseBackupWebdavConfigPayload,
  parseBackupWebdavExportPayload,
} from '../../contracts/settingsRoutePayloads.js';
import { rejectTunnelAdminAction } from '../../tunnelAccessPolicy.js';

/**
 * Backup/WebDAV endpoints split out of settingsRoutes. Registered by direct
 * call so the Fastify encapsulation context and auth hooks stay identical.
 *
 * applyImportedSetting is injected by settings.ts instead of imported: the
 * runtime-config applier lives there, and importing settings.ts back from this
 * module would create a cycle.
 */
interface BackupWebdavConfigBody {
  enabled?: unknown;
  fileUrl?: unknown;
  username?: unknown;
  password?: unknown;
  clearPassword?: unknown;
  exportType?: unknown;
  autoSyncEnabled?: unknown;
  autoSyncCron?: unknown;
}

export function registerSettingsBackupRoutes(
  app: FastifyInstance,
  options: { applyImportedSetting: (key: string, value: unknown) => void },
): void {
  const { applyImportedSetting } = options;
  app.get<{ Querystring: { type?: string } }>('/api/settings/backup/export', async (request, reply) => {
    const rawType = String(request.query.type || 'all').trim().toLowerCase();
    const type: BackupExportType = rawType === 'accounts' || rawType === 'preferences' ? rawType : 'all';
    if (rawType && !['all', 'accounts', 'preferences'].includes(rawType)) {
      return reply.code(400).send({ success: false, message: '导出类型无效，仅支持 all/accounts/preferences' });
    }
    return await exportBackup(type);
  });

  app.post<{ Body: unknown }>('/api/settings/backup/import', async (request, reply) => {
    if (rejectTunnelAdminAction(request, reply, '导入备份数据')) return reply;
    const parsedBody = parseBackupImportPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: '导入数据格式错误：需要 JSON 对象' });
    }

    try {
      const result = await importBackup(parsedBody.data.data);
      for (const item of result.appliedSettings) {
        applyImportedSetting(item.key, item.value);
      }
      if (result.appliedSettings.some((item) => item.key === 'backup_webdav_config_v1')) {
        await reloadBackupWebdavScheduler();
      }
      return {
        success: true,
        message: '导入完成',
        ...result,
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        success: false,
        message: errMessage || '导入失败',
      });
    }
  });

  app.get('/api/settings/backup/webdav', async () => {
    return getBackupWebdavConfig();
  });

  app.put<{ Body: BackupWebdavConfigBody }>('/api/settings/backup/webdav', async (request, reply) => {
    if (rejectTunnelAdminAction(request, reply, '修改 WebDAV 备份配置')) return reply;
    try {
      const parsedBody = parseBackupWebdavConfigPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: parsedBody.error,
        });
      }

      const body = parsedBody.data;
      const result = await saveBackupWebdavConfig({
        enabled: body.enabled === undefined ? undefined : body.enabled === true,
        fileUrl: body.fileUrl === undefined ? undefined : String(body.fileUrl || ''),
        username: body.username === undefined ? undefined : String(body.username || ''),
        password: body.password === undefined ? undefined : String(body.password),
        clearPassword: body.clearPassword === true,
        exportType: body.exportType === undefined ? undefined : String(body.exportType || '') as BackupExportType,
        autoSyncEnabled: body.autoSyncEnabled === undefined ? undefined : body.autoSyncEnabled === true,
        autoSyncCron: body.autoSyncCron === undefined ? undefined : String(body.autoSyncCron || ''),
      });
      return result;
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        success: false,
        message: errMessage || 'WebDAV 配置保存失败',
      });
    }
  });

  app.post<{ Body: { type?: string } }>('/api/settings/backup/webdav/export', async (request, reply) => {
    if (rejectTunnelAdminAction(request, reply, '从 WebDAV 导出备份')) return reply;
    try {
      const parsedBody = parseBackupWebdavExportPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: parsedBody.error,
        });
      }

      const rawType = typeof parsedBody.data.type === 'string' ? parsedBody.data.type.trim().toLowerCase() : '';
      const type: BackupExportType | undefined = rawType === 'all' || rawType === 'accounts' || rawType === 'preferences'
        ? rawType
        : undefined;
      return await exportBackupToWebdav(type);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        success: false,
        message: errMessage || 'WebDAV 导出失败',
      });
    }
  });

  app.post('/api/settings/backup/webdav/import', async (request, reply) => {
    if (rejectTunnelAdminAction(request, reply, '从 WebDAV 导入备份')) return reply;
    try {
      const result = await importBackupFromWebdav();
      for (const item of result.appliedSettings) {
        applyImportedSetting(item.key, item.value);
      }
      if (result.appliedSettings.some((item) => item.key === 'backup_webdav_config_v1')) {
        await reloadBackupWebdavScheduler();
      }
      return result;
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        success: false,
        message: errMessage || 'WebDAV 导入失败',
      });
    }
  });
}
