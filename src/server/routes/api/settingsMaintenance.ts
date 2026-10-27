import type { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import * as routeRefreshWorkflow from '../../services/routeRefreshWorkflow.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import {
  deleteAdminSnapshot,
  readAdminSnapshot,
  writeAdminSnapshot,
} from '../../services/adminSnapshotStore.js';
import { performFactoryReset } from '../../services/factoryResetService.js';
import { rejectTunnelAdminAction } from '../../tunnelAccessPolicy.js';
import { appendSettingsEvent } from './settingsShared.js';

/**
 * Maintenance/destructive endpoints split out of settingsRoutes. Registered by
 * direct call (not app.register) so they keep the same Fastify encapsulation
 * context and auth hooks as the rest of the settings surface.
 */
export function registerSettingsMaintenanceRoutes(app: FastifyInstance): void {
  app.post('/api/settings/maintenance/clear-cache', async (request, reply) => {
    const body = (request.body || {}) as { confirm?: unknown };
    if (body.confirm !== true) {
      return reply.code(400).send({
        success: false,
        message: '危险操作需要确认：请携带 confirm:true 后重试',
      });
    }
    const { task, reused } = startBackgroundTask(
      {
        type: 'maintenance',
        title: '清理缓存并重建路由',
        dedupeKey: 'refresh-models-and-rebuild-routes',
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const rebuild = (currentTask.result as any)?.rebuild;
          if (!rebuild) return '缓存清理后重建路由已完成';
          return `缓存清理后重建完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
        },
        failureMessage: (currentTask) => `缓存清理后重建失败：${currentTask.error || 'unknown error'}`,
      },
      async () => {
        // Snapshot BEFORE any deletion so a failed rebuild can restore the
        // exact previous routing state (routes + group-source links).
        const tokenRoutesSnapshot = await db.select().from(schema.tokenRoutes).all();
        const groupSourcesSnapshot = await db.select().from(schema.routeGroupSources).all();
        const SNAPSHOT_NS = 'clear-cache-rollback';
        const SNAPSHOT_KEY = 'routes';
        const nowIso = new Date().toISOString();
        if (tokenRoutesSnapshot.length > 0 || groupSourcesSnapshot.length > 0) {
          await writeAdminSnapshot(
            { namespace: SNAPSHOT_NS, key: SNAPSHOT_KEY },
            {
              payload: { tokenRoutes: tokenRoutesSnapshot, groupSources: groupSourcesSnapshot },
              generatedAt: nowIso,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              staleUntil: nowIso,
            },
          );
        }

        try {
          await db.delete(schema.modelAvailability).run();
          await db.delete(schema.routeChannels).run();
          await db.delete(schema.tokenRoutes).run();

          const rebuild = await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
          await deleteAdminSnapshot({ namespace: SNAPSHOT_NS, key: SNAPSHOT_KEY });
          return { rebuild, deletedModelAvailability: true, deletedRouteChannels: true, deletedTokenRoutes: true };
        } catch (rebuildErr) {
          // Rollback best-effort: the tables are empty at this point, so a
          // plain re-insert (with preserved ids) restores the exact state.
          try {
            const snapshot = await readAdminSnapshot<{
              tokenRoutes: typeof tokenRoutesSnapshot;
              groupSources: typeof groupSourcesSnapshot;
            }>(
              { namespace: SNAPSHOT_NS, key: SNAPSHOT_KEY },
            );
            if (snapshot) {
              const { tokenRoutes: savedRoutes, groupSources: savedGroupSources } = snapshot.payload;
              for (let i = 0; i < savedRoutes.length; i += 200) {
                await db.insert(schema.tokenRoutes).values(savedRoutes.slice(i, i + 200)).run();
              }
              for (let i = 0; i < savedGroupSources.length; i += 200) {
                await db.insert(schema.routeGroupSources).values(savedGroupSources.slice(i, i + 200)).run();
              }
              // Rebuild route channels from the restored routes so the router
              // has working channels again even if the model refresh failed.
              try {
                await routeRefreshWorkflow.rebuildRoutesOnly();
              } catch { /* best-effort */ }
            }
            await deleteAdminSnapshot({ namespace: SNAPSHOT_NS, key: SNAPSHOT_KEY });
          } catch {
            /* rollback best-effort */
          }
          throw rebuildErr;
        }
      },
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      message: '缓存清理与路由重建已排入后台任务',
    });
  });

  app.post('/api/settings/maintenance/clear-usage', async (request, reply) => {
    const body = (request.body || {}) as { confirm?: unknown };
    if (body.confirm !== true) {
      return reply.code(400).send({
        success: false,
        message: '危险操作需要确认：请携带 confirm:true 后重试',
      });
    }
    const deletedProxyLogs = (await db.delete(schema.proxyLogs).run()).changes;

    await db.update(schema.routeChannels).set({
      successCount: 0,
      failCount: 0,
      totalLatencyMs: 0,
      totalCost: 0,
      lastUsedAt: null,
      lastSelectedAt: null,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
      cooldownUntil: null,
    }).run();

    await db.update(schema.accounts).set({
      balanceUsed: 0,
      updatedAt: new Date().toISOString(),
    }).run();

    appendSettingsEvent({
      type: 'status',
      title: '占用统计与使用日志已清理',
      message: `已清理使用日志 ${deletedProxyLogs} 条，并重置路由与账号占用统计`,
      level: 'warning',
    });

    return {
      success: true,
      message: '占用统计已清理',
      deletedProxyLogs,
    };
  });

  app.post('/api/settings/maintenance/factory-reset', async (request, reply) => {
    if (rejectTunnelAdminAction(request, reply, '恢复出厂设置')) return reply;
    const body = (request.body || {}) as { confirm?: unknown };
    if (body.confirm !== true) {
      return reply.code(400).send({
        success: false,
        message: '危险操作需要确认：请携带 confirm:true 后重试',
      });
    }
    try {
      await performFactoryReset();
      return {
        success: true,
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({
        success: false,
        message: errMessage || '重新初始化系统失败',
      });
    }
  });
}
