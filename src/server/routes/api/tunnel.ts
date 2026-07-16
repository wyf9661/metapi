import type { FastifyInstance } from 'fastify';
import {
  getCloudflareTunnelStatus,
  setTunnelDashboardAccess,
  startCloudflareTunnel,
  stopCloudflareTunnel,
} from '../../services/cloudflareTunnelService.js';

export async function tunnelRoutes(app: FastifyInstance) {
  app.get('/api/tunnel/status', async () => {
    return {
      tunnel: getCloudflareTunnelStatus(),
    };
  });

  app.post('/api/tunnel/enable', async (_request, reply) => {
    try {
      const status = await startCloudflareTunnel();
      return {
        success: true,
        message: status.running ? '隧道已启用' : '隧道启动中',
        tunnel: status,
      };
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        message: error?.message || '启用隧道失败',
        tunnel: getCloudflareTunnelStatus(),
      });
    }
  });

  app.post('/api/tunnel/disable', async () => {
    await stopCloudflareTunnel({ persistDisabled: true });
    return {
      success: true,
      message: '隧道已禁用',
      tunnel: getCloudflareTunnelStatus(),
    };
  });

  app.put<{ Body: { dashboardAccess?: boolean } }>('/api/tunnel/dashboard-access', async (request, reply) => {
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
