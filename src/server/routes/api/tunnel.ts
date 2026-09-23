import type { FastifyInstance } from 'fastify';
import {
  getCloudflareTunnelStatus,
  isLikelyTunnelRequest,
  setTunnelDashboardAccess,
  startCloudflareTunnel,
  stopCloudflareTunnel,
} from '../../services/cloudflareTunnelService.js';
import { rejectTunnelAdminAction } from '../../tunnelAccessPolicy.js';

export async function tunnelRoutes(app: FastifyInstance) {
  app.get('/api/tunnel/status', async (request) => {
    return {
      tunnel: getCloudflareTunnelStatus(),
      // Same authoritative flag as /api/settings/runtime, for the dashboard.
      tunnelClientView: isLikelyTunnelRequest(request as any),
    };
  });

  app.post('/api/tunnel/enable', async (request, reply) => {
    // Allow enable only from local/console; tunnel clients should not reconfigure tunnel lifecycle.
    if (rejectTunnelAdminAction(request, reply, '创建/启用隧道')) return;
    try {
      const status = await startCloudflareTunnel();
      return {
        success: true,
        message: status.running ? '隧道已启用' : '隧道启动中',
        tunnel: status,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({
        success: false,
        message: errorMessage || '启用隧道失败',
        tunnel: getCloudflareTunnelStatus(),
      });
    }
  });

  app.post('/api/tunnel/disable', async (request, reply) => {
    if (rejectTunnelAdminAction(request, reply, '关闭隧道')) return;
    await stopCloudflareTunnel({ persistDisabled: true });
    return {
      success: true,
      message: '隧道已禁用',
      tunnel: getCloudflareTunnelStatus(),
    };
  });

  app.put<{ Body: { dashboardAccess?: boolean } }>('/api/tunnel/dashboard-access', async (request, reply) => {
    if (rejectTunnelAdminAction(request, reply, '修改隧道控制台访问权限')) return;
    const body = request.body || {};
    if (typeof body.dashboardAccess !== 'boolean') {
      return reply.code(400).send({ success: false, message: 'dashboardAccess 必须为 boolean' });
    }
    await setTunnelDashboardAccess(body.dashboardAccess);
    return {
      success: true,
      tunnel: getCloudflareTunnelStatus(),
    };
  });
}
