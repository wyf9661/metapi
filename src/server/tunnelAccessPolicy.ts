import type { FastifyReply, FastifyRequest } from 'fastify';
import { isLikelyTunnelRequest } from './services/cloudflareTunnelService.js';

/**
 * Single source of truth for the public-tunnel access policy.
 *
 * The tunnel exists to expose the OpenAI-compatible API. Everything that can
 * sever the remote session, replace instance identity/credentials, or destroy
 * the dataset stays local-only even when the console itself is tunnel-enabled;
 * the console mirrors this through the `tunnelClientView` flag rather than
 * re-deriving it from the hostname.
 */

/** Whether this request arrived through the public tunnel. */
export function isTunnelAdminRequest(request: FastifyRequest): boolean {
  return isLikelyTunnelRequest(request as any);
}

/**
 * Reject a tunnel-originated request that must be performed locally.
 * Returns true when the response has already been sent.
 */
export function rejectTunnelAdminAction(
  request: FastifyRequest,
  reply: FastifyReply,
  action: string,
): boolean {
  if (!isTunnelAdminRequest(request)) return false;
  reply.code(403).send({
    success: false,
    error: 'Tunnel admin-only action denied',
    message: `通过公网隧道时不允许${action}。请在本机/内网控制台操作。`,
  });
  return true;
}
