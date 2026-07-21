import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');
type StoreModule = typeof import('../../services/proxyDebugTraceStore.js');

describe('stats proxy debug api', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-stats-proxy-debug-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const storeModule = await import('../../services/proxyDebugTraceStore.js');
    const statsRoutesModule = await import('./stats.js');

    db = dbModule.db;
    schema = dbModule.schema;
    store = storeModule;

    app = Fastify();
    await app.register(statsRoutesModule.statsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.proxyDebugAttempts).run();
    await db.delete(schema.proxyDebugTraces).run();
  });

  afterAll(async () => {
    await app.close();
    const dbModule = await import('../../db/index.js');
    await dbModule.closeDbConnections();
    delete process.env.DATA_DIR;
  });

  it('lists and returns proxy debug traces with attempt details', async () => {
    const trace = await store.createProxyDebugTrace({
      downstreamPath: '/v1/chat/completions',
      clientKind: 'codex',
      sessionId: 'sess-9',
      traceHint: 'trace-x',
      requestedModel: 'gpt-4.1',
      requestHeaders: { authorization: 'Bearer test' },
      requestBody: { model: 'gpt-4.1' },
    });
    await store.insertProxyDebugAttempt({
      traceId: trace.id,
      attemptIndex: 0,
      endpoint: 'chat',
      requestPath: '/v1/chat/completions',
      targetUrl: 'https://example.com/v1/chat/completions',
      runtimeExecutor: 'default',
      requestHeaders: { authorization: 'Bearer test' },
      requestBody: { model: 'gpt-4.1' },
      responseStatus: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: { id: 'chatcmpl_123' },
      rawErrorText: null,
      recoverApplied: false,
      downgradeDecision: false,
      downgradeReason: null,
      memoryWrite: { action: 'success', preferredEndpoint: 'chat' },
    });
    await store.finalizeProxyDebugTrace(trace.id, {
      finalStatus: 'success',
      finalHttpStatus: 200,
      finalUpstreamPath: '/v1/chat/completions',
      finalResponseHeaders: { 'content-type': 'application/json' },
      finalResponseBody: { id: 'chatcmpl_123' },
    });

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/stats/proxy-debug/traces?limit=10',
    });
    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json() as { items?: Array<{ id: number; finalStatus: string }> };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items?.[0]?.finalStatus).toBe('success');

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/stats/proxy-debug/traces/${trace.id}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detailBody = detailResponse.json() as {
      trace?: { requestedModel?: string; sessionId?: string };
      attempts?: Array<{ endpoint?: string; responseStatus?: number }>;
    };
    expect(detailBody.trace).toMatchObject({
      requestedModel: 'gpt-4.1',
      sessionId: 'sess-9',
    });
    expect(detailBody.attempts?.[0]).toMatchObject({
      endpoint: 'chat',
      responseStatus: 200,
    });
  });

  it('clears all proxy debug traces and resets identity so next id starts at 1', async () => {
    const first = await store.createProxyDebugTrace({
      downstreamPath: '/v1/chat/completions',
      clientKind: 'codex',
      sessionId: 'sess-1',
      requestedModel: 'gpt-4.1',
    });
    await store.insertProxyDebugAttempt({
      traceId: first.id,
      attemptIndex: 0,
      endpoint: 'chat',
      requestPath: '/v1/chat/completions',
      targetUrl: 'https://example.com/v1/chat/completions',
      responseStatus: 500,
    });
    const second = await store.createProxyDebugTrace({
      downstreamPath: '/v1/responses',
      clientKind: 'codex',
      sessionId: 'sess-2',
      requestedModel: 'gpt-5',
    });
    expect(second.id).toBeGreaterThan(first.id);

    const clearResponse = await app.inject({
      method: 'DELETE',
      url: '/api/stats/proxy-debug/traces',
    });
    expect(clearResponse.statusCode).toBe(200);
    const clearBody = clearResponse.json() as {
      ok?: boolean;
      deletedTraces?: number;
      deletedAttempts?: number;
    };
    expect(clearBody.ok).toBe(true);
    expect(clearBody.deletedTraces).toBeGreaterThanOrEqual(2);
    expect(clearBody.deletedAttempts).toBeGreaterThanOrEqual(1);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/stats/proxy-debug/traces?limit=10',
    });
    expect(listResponse.statusCode).toBe(200);
    expect((listResponse.json() as { items?: unknown[] }).items).toEqual([]);

    const recreated = await store.createProxyDebugTrace({
      downstreamPath: '/v1/chat/completions',
      clientKind: 'codex',
      sessionId: 'sess-reset',
      requestedModel: 'gpt-4.1',
    });
    expect(recreated.id).toBe(1);
  });
});
