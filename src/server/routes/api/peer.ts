import { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { secretsEqual } from '../../middleware/auth.js';
import { getDashboardSummarySnapshot } from '../../services/dashboardSnapshotService.js';

/**
 * Peer overview: read-only site-level metrics for cascaded MetAPI instances.
 *
 * This is the metapi-platform counterpart of new-api's per-user panel: the
 * credential is the ADMIN token, so a peer that presents it gets the same
 * numbers the local dashboard shows (total balance across active site
 * accounts, today's spend, today's checkin reward). Anything else — a
 * downstream `sk-` key, a wrong token, no token — is rejected with a bare
 * 401 that carries no MetAPI-specific marker, so the endpoint is
 * indistinguishable from any other admin API and cannot be probed without
 * holding the admin credential.
 */

const PEER_PROTOCOL_VERSION = 1;

function roundMicro(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function extractBearerToken(request: { headers: Record<string, unknown> }): string | null {
  const auth = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
  return auth.replace(/^Bearer\s+/i, '').trim() || null;
}

export async function peerRoutes(app: FastifyInstance) {
  app.get('/api/v1/peer/overview', async (request, reply) => {
    const token = extractBearerToken(request) || '';
    // Constant-time compare; a wrong/missing token is a featureless 401.
    if (!token || !secretsEqual(token, config.authToken)) {
      reply.code(401).send({ error: 'Invalid token' });
      return;
    }

    const summary = await getDashboardSummarySnapshot();
    const payload = summary.payload;
    reply.send({
      protocolVersion: PEER_PROTOCOL_VERSION,
      site: {
        totalBalance: roundMicro(payload.totalBalance),
        totalUsed: roundMicro(payload.totalUsed),
        activeAccounts: payload.activeAccounts,
        totalAccounts: payload.totalAccounts,
      },
      today: {
        spend: roundMicro(payload.todaySpend),
        reward: roundMicro(payload.todayReward),
        checkin: payload.todayCheckin,
      },
      updatedAt: new Date().toISOString(),
    });
  });
}
