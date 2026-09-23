import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { normalizeIp } from '../../middleware/clientIp.js';
import { config } from '../../config.js';
import { eq } from 'drizzle-orm';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { secretsEqual } from '../../middleware/auth.js';
import { parseAuthChangePayload } from '../../contracts/supportRoutePayloads.js';
import { rejectTunnelAdminAction } from '../../tunnelAccessPolicy.js';

const limitAdminTokenChange = createRateLimitGuard({
  bucket: 'auth-change',
  max: 3,
  windowMs: 60_000,
});

export async function authRoutes(app: FastifyInstance) {
  // Change admin auth token (requires old token verification)
  app.post<{ Body: unknown }>(
    '/api/settings/auth/change',
    { preHandler: [limitAdminTokenChange] },
    async (request, reply) => {
    if (rejectTunnelAdminAction(request, reply, '修改管理员登录令牌')) return;

    const parsedBody = parseAuthChangePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const { oldToken, newToken } = parsedBody.data;

    if (!oldToken || !newToken) {
      return reply.code(400).send({ success: false, message: '请填写所有字段' });
    }

    if (newToken.length < 8) {
      return reply.code(400).send({ success: false, message: '新 Token 至少 8 个字符' });
    }

    if (!secretsEqual(oldToken, config.authToken)) {
      return reply.code(403).send({ success: false, message: '旧 Token 验证失败' });
    }

    // Save to settings table
    const existing = await db.select().from(schema.settings).where(eq(schema.settings.key, 'auth_token')).get();
    if (existing) {
      await db.update(schema.settings).set({ value: JSON.stringify(newToken) }).where(eq(schema.settings.key, 'auth_token')).run();
    } else {
      await db.insert(schema.settings).values({ key: 'auth_token', value: JSON.stringify(newToken) }).run();
    }

    // Update runtime config
    config.authToken = newToken;

    try {
      const createdAt = formatUtcSqlDateTime(new Date());
      await db.insert(schema.events).values({
        type: 'token',
        title: '管理员登录令牌已更新',
        message: '管理员登录 Token 已被修改，请使用新 Token 登录。',
        level: 'warning',
        relatedType: 'settings',
        createdAt,
      }).run();
    } catch {}

    return { success: true, message: 'Token 已更新' };
    },
  );

  // Get masked current token (for display)
  app.get('/api/settings/auth/info', async (request) => {
    const token = config.authToken;
    const masked = token.length > 8
      ? token.slice(0, 4) + '****' + token.slice(-4)
      : '****';

    // Desktop only: on first launch the backend synthesizes a random admin
    // token (buildDesktopServerEnv). Until the user changes it from the UI and
    // it is persisted to the settings table, there is no way for them to know
    // that value. Expose it here as bootstrapToken so the login screen can show
    // it once. To keep the live token off the LAN, only expose when the
    // request arrives from the local loopback (same machine).
    let bootstrapToken: string | null = null;
    const isDesktop = process.env.METAPI_DESKTOP === '1';
    if (isDesktop && normalizeIp(request.ip) === '127.0.0.1') {
      const persisted = await db.select().from(schema.settings).where(eq(schema.settings.key, 'auth_token')).get();
      if (!persisted) {
        bootstrapToken = token;
      }
    }

    return { masked, bootstrapToken };
  });

  // Guarded echo endpoint for the web login gate. It is intentionally NOT in
  // the public route allowlist (isPublicApiRoute), so authMiddleware rejects a
  // wrong token with 403 before this handler runs. The login screen validates
  // against this route; validating against the public /auth/info above let any
  // input "sign in" because that route never checks the Authorization header.
  app.get('/api/settings/auth/verify', async () => ({ success: true }));
}
