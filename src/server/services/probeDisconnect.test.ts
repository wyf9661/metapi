import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

// 真实本地上游，记录客户端（MetAPI）是否提前断开连接
let upstream: Server;
let upstreamRequests: Array<{ aborted: boolean; completed: boolean }> = [];
let db: DbModule['db'];
let schema: DbModule['schema'];
let probeSiteModels: ModelServiceModule['probeSiteModels'];
let dataDir = '';

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'metapi-probe-disconnect-'));
  process.env.DATA_DIR = dataDir;
  await import('../db/migrate.js');
  const dbModule = await import('../db/index.js');
  const modelService = await import('./modelService.js');
  db = dbModule.db;
  schema = dbModule.schema;
  probeSiteModels = modelService.probeSiteModels;

  upstream = createServer((req, res) => {
    const record: { aborted: boolean; completed: boolean } = { aborted: false, completed: false };
    req.on('close', () => {
      if (!res.writableEnded) record.aborted = true;
    });
    res.on('finish', () => {
      record.completed = true;
    });
    upstreamRequests.push(record);
    // 故意慢响应：200ms 后才返回，留出「客户端断开」的窗口
    setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      }
    }, 200);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  delete process.env.DATA_DIR;
});

describe('probe client-disconnect does NOT abort upstream', () => {
  let siteId = 0;
  let accountId = 0;

  beforeEach(async () => {
    await db.delete(schema.probeLogs).run();
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();

    const upstreamPort = (upstream.address() as { port: number }).port;
    const site = await db.insert(schema.sites).values({
      name: 'probe-disconnect-site',
      url: `http://127.0.0.1:${upstreamPort}`,
      platform: 'new-api',
      status: 'active',
      sortOrder: 999,
    }).returning().get();
    siteId = site.id;

    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'probe-disconnect-user',
      accessToken: 'sk-probe-disconnect',
      apiToken: 'sk-probe-disconnect',
      status: 'active',
    }).returning().get();
    accountId = account.id;

    await db.insert(schema.modelAvailability).values({
      accountId,
      modelName: 'gpt-test-probe',
      available: true,
    }).run();

    upstreamRequests = [];
  });

  it('aborting the external probe signal leaves the in-flight upstream request untouched', async () => {
    const probeAbort = new AbortController();

    // 探测请求打到本地上游（慢响应 200ms）。外部 signal 在 50ms 时 abort，
    // 模拟「用户切走页面 → reply.raw close → probeAbort.abort()」
    const promise = probeSiteModels(
      siteId,
      {
        scope: 'single',
        modelName: 'gpt-test-probe',
        signal: probeAbort.signal,
      },
      () => {},
    );

    setTimeout(() => probeAbort.abort(), 50);

    const result = await promise;
    expect(result.success).toBe(true);

    // 上游必须收到完整请求：连接没有被 abort
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(upstreamRequests.length).toBeGreaterThan(0);
    const sawAbortedConnection = upstreamRequests.some((r) => r.aborted);
    expect(sawAbortedConnection).toBe(false);
    expect(upstreamRequests.some((r) => r.completed)).toBe(true);
  });
});
