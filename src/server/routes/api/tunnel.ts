import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  getCloudflareTunnelStatus,
  isLikelyTunnelRequest,
  setTunnelDashboardAccess,
  startCloudflareTunnel,
  stopCloudflareTunnel,
} from '../../services/cloudflareTunnelService.js';

function rejectTunnelSelfManagement(request: FastifyRequest, reply: FastifyReply, action: string): boolean {
  if (!isLikelyTunnelRequest(request as any)) return false;
  reply.code(403).send({
    success: false,
    error: 'Tunnel self-management denied',
    message: `通过公网隧道时不允许${action}。请在本机/内网控制台操作。`,
  });
  return true;
}

export async function tunnelRoutes(app: FastifyInstance) {
  app.get('/api/tunnel/status', async () => {
    return {
      tunnel: getCloudflareTunnelStatus(),
    };
  });

  app.post('/api/tunnel/enable', async (request, reply) => {
    // Allow enable only from local/console; tunnel clients should not reconfigure tunnel lifecycle.
    if (rejectTunnelSelfManagement(request, reply, '创建/启用隧道')) return;
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

  app.post('/api/tunnel/disable', async (request, reply) => {
    if (rejectTunnelSelfManagement(request, reply, '关闭隧道')) return;
    await stopCloudflareTunnel({ persistDisabled: true });
    return {
      success: true,
      message: '隧道已禁用',
      tunnel: getCloudflareTunnelStatus(),
    };
  });

  app.put<{ Body: { dashboardAccess?: boolean } }>('/api/tunnel/dashboard-access', async (request, reply) => {
    if (rejectTunnelSelfManagement(request, reply, '修改隧道控制台访问权限')) return;
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
