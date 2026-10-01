import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetRequestRateLimitStore } from '../../middleware/requestRateLimit.js';

type DbModule = typeof import('../../db/index.js');
type ConfigModule = typeof import('../../config.js');

describe('GET /api/settings/runtime secret masking', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-secret-masking-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const routesModule = await import('./settings.js');
    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;

    app = Fastify();
    await app.register(routesModule.settingsRoutes);
  });

  beforeEach(async () => {
    resetRequestRateLimitStore();
    await db.delete(schema.settings).run();
    (config as any).webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/abc';
    (config as any).webhookSecret = 'super-secret-webhook-key';
    (config as any).serverChanKey = 'SCT9999longkey';
    (config as any).telegramBotToken = '12345:AAH-secret-token';
    (config as any).smtpPass = 'mail-password';
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('masks the webhook secret like every other notification secret', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    // Old code: webhookSecret was returned in full.
    expect(body.webhookSecret).toBeUndefined();
    expect(body.webhookSecretMasked).toBe('supe****-key');
    // Neighbouring secrets stay masked (regression pins).
    expect(body.serverChanKeyMasked).not.toBe('SCT9999longkey');
    expect(body.telegramBotTokenMasked).not.toBe('12345:AAH-secret-token');
    expect(body.smtpPassMasked).not.toBe('mail-password');
    // The secret must not appear anywhere in the payload.
    expect(res.body).not.toContain('super-secret-webhook-key');
  });
});
