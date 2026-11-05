import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync, zstdCompressSync } from 'node:zlib';
import { Response } from 'undici';
import { describe, expect, it } from 'vitest';
import { enrichTransportFailure, getRuntimeResponseReader, isDeltaMissOrDowngrade, materializeErrorResponse, MAX_JSON_UPSTREAM_BODY_TEXT_CHARS, performFetch, readRuntimeResponseText } from './types.js';
import { __resetChunkedBodyUploadForTests } from '../../services/requestBodyChunkedUpload.js';
import { REQUEST_BODY_DELTA_CAPABILITY_HEADER } from '../../services/requestBodyDelta.js';

describe('isDeltaMissOrDowngrade', () => {
  const response = (status: number, delta: string | null) => ({
    status,
    headers: {
      get: (name: string) =>
        name === REQUEST_BODY_DELTA_CAPABILITY_HEADER ? delta : null,
    },
  }) as never;

  it('retries only an expired base or a peer that no longer speaks delta', () => {
    expect(isDeltaMissOrDowngrade(response(409, 'miss'))).toBe(true);
    expect(isDeltaMissOrDowngrade(response(400, null))).toBe(true);
    // A delta-capable peer answered on its own terms: the body was fine.
    expect(isDeltaMissOrDowngrade(response(409, 'v1'))).toBe(false);
    expect(isDeltaMissOrDowngrade(response(400, 'v1'))).toBe(false);
    expect(isDeltaMissOrDowngrade(response(500, null))).toBe(false);
  });
});

describe('readRuntimeResponseText', () => {
  it('decompresses zstd responses before reading the body text', async () => {
    const payload = JSON.stringify({ ok: true, text: 'hello zstd' });
    const response = new Response(zstdCompressSync(Buffer.from(payload)), {
      status: 200,
      headers: {
        'content-encoding': 'zstd',
        'content-type': 'application/json; charset=utf-8',
      },
    });

    await expect(readRuntimeResponseText(response)).resolves.toBe(payload);
  });

  it('decompresses stacked content-encodings in reverse order', async () => {
    const payload = JSON.stringify({ ok: true, text: 'stacked' });
    const response = new Response(
      zstdCompressSync(gzipSync(Buffer.from(payload))),
      {
        status: 200,
        headers: {
          'content-encoding': 'gzip, zstd',
          'content-type': 'application/json; charset=utf-8',
        },
      },
    );

    await expect(readRuntimeResponseText(response)).resolves.toBe(payload);
  });

  it('truncates oversized bodies to protect process memory', async () => {
    // Build a body larger than the 1 MiB cap.
    const bigPayload = `{"error":"${'x'.repeat(2 * 1024 * 1024)}"}`;
    const response = new Response(bigPayload, {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    const text = await readRuntimeResponseText(response);
    expect(text.length).toBeLessThan(bigPayload.length);
    expect(text).toContain('[truncated');
  });

  it('passes through bodies within the cap unchanged', async () => {
    const payload = JSON.stringify({ ok: true, text: 'within cap' });
    const response = new Response(payload, {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    await expect(readRuntimeResponseText(response)).resolves.toBe(payload);
  });

  it('honours a larger explicit maxChars so legitimate big JSON survives intact', async () => {
    // /v1/images and friends can return a multi-MiB b64_json payload or a
    // dense embedding vector array; the caller opts in to a bigger cap and
    // the full body must round-trip parseable.
    const bigPayload = JSON.stringify({
      data: [{ b64_json: 'A'.repeat(2 * 1024 * 1024) }],
    });
    const response = new Response(bigPayload, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    const text = await readRuntimeResponseText(response, {
      maxChars: MAX_JSON_UPSTREAM_BODY_TEXT_CHARS,
    });
    expect(text).toBe(bigPayload);
    expect(JSON.parse(text).data[0].b64_json).toHaveLength(2 * 1024 * 1024);
  });

  it('rejects an oversized successful JSON body instead of forwarding truncated JSON', async () => {
    const bigPayload = JSON.stringify({ data: [{ b64_json: 'B'.repeat(2 * 1024 * 1024) }] });
    const response = new Response(bigPayload, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    await expect(readRuntimeResponseText(response, { maxChars: 1024, rejectOnOverflow: true }))
      .rejects.toThrow('exceeds');
  });

  it('preserves the truncation marker for oversized error bodies with a custom maxChars', async () => {
    const response = new Response('E'.repeat(2_048), { status: 500 });
    const text = await readRuntimeResponseText(response, { maxChars: 1_024 });
    expect(text).toContain('[truncated');
    expect(text.length).toBeLessThan(2_048);
  });

  it('cancels an oversized streaming body without waiting for the upstream to close', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8_192));
        // Intentionally never close: an unbounded reader will hang.
      },
      cancel() { cancelled = true; },
    }), { status: 500 });
    const controller = new AbortController();
    const fallback = setTimeout(() => controller.abort(), 200);
    try {
      const text = await readRuntimeResponseText(response, {
        maxChars: 1_024, signal: controller.signal,
      });
      expect(text).toContain('[truncated');
      expect(cancelled).toBe(true);
    } finally {
      clearTimeout(fallback);
    }
  });

  it('cancels a non-stream body that goes idle after its first chunk', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":true}'));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    await expect(readRuntimeResponseText(response, { idleTimeoutMs: 30 }))
      .rejects.toThrow('response body idle timeout');
    expect(cancelled).toBe(true);
  });

  it('cancels a non-stream body when the caller aborts while waiting for more data', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('{"partial":true}'));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    const pending = readRuntimeResponseText(response, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });

  it('decompresses a gzip body while the idle guard is active', async () => {
    const payload = JSON.stringify({ ok: true, text: 'gzipped with guard' });
    const response = new Response(gzipSync(Buffer.from(payload)), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    });

    await expect(readRuntimeResponseText(response, { idleTimeoutMs: 5_000 }))
      .resolves.toBe(payload);
  });

  it('decompresses a zstd body exactly once while the idle guard is active', async () => {
    const payload = JSON.stringify({ ok: true, text: 'zstd with guard' });
    const response = new Response(zstdCompressSync(Buffer.from(payload)), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
    });

    await expect(readRuntimeResponseText(response, { idleTimeoutMs: 5_000 }))
      .resolves.toBe(payload);
  });
});

describe('materializeErrorResponse', () => {
  it('decodes compressed error bodies and strips compression headers', async () => {
    const payload = JSON.stringify({ error: { message: 'upstream failed' } });
    const response = new Response(zstdCompressSync(Buffer.from(payload)), {
      status: 503,
      headers: {
        'content-encoding': 'zstd',
        'content-length': '999',
        'content-type': 'application/json; charset=utf-8',
      },
    });

    const materialized = await materializeErrorResponse(response);

    await expect(materialized.text()).resolves.toBe(payload);
    expect(materialized.headers.get('content-encoding')).toBeNull();
    expect(materialized.headers.get('content-length')).toBeNull();
    expect(materialized.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

describe('getRuntimeResponseReader', () => {
  it('falls back to the original stream when the body is already decompressed despite a zstd header', async () => {
    const payload = 'data: {"ok":true}\n\n';
    const response = new Response(payload, {
      status: 200,
      headers: {
        'content-encoding': 'zstd',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    });

    const reader = getRuntimeResponseReader(response);

    expect(reader).toBeDefined();
    const firstChunk = await reader?.read();

    expect(firstChunk?.done).toBe(false);
    expect(Buffer.from(firstChunk?.value ?? []).toString('utf8')).toBe(payload);
  });

  it('decompresses stacked streaming encodings when zstd is not the outermost layer', async () => {
    const payload = 'data: {"ok":true,"kind":"stacked"}\n\n';
    const response = new Response(gzipSync(zstdCompressSync(Buffer.from(payload))), {
      status: 200,
      headers: {
        'content-encoding': 'zstd, gzip',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    });

    const reader = getRuntimeResponseReader(response);

    expect(reader).toBeDefined();
    const firstChunk = await reader?.read();

    expect(firstChunk?.done).toBe(false);
    expect(Buffer.from(firstChunk?.value ?? []).toString('utf8')).toBe(payload);
  });
});

describe('enrichTransportFailure', () => {
  const fetchFailed = (cause: unknown) => {
    const error = new TypeError('fetch failed') as TypeError & { cause?: unknown };
    error.cause = cause;
    return error;
  };

  it('folds a DNS cause into the message', () => {
    const error = fetchFailed(Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
      code: 'ENOTFOUND',
      hostname: 'api.example.com',
    }));

    expect(enrichTransportFailure(error).message).toBe('fetch failed (ENOTFOUND api.example.com)');
  });

  it('folds every attempted address of an AggregateError', () => {
    const error = fetchFailed(new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED', address: '::1', port: 443 }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 443 }),
    ], 'all addresses failed'));

    expect(enrichTransportFailure(error).message)
      .toBe('fetch failed (ECONNREFUSED ::1:443; ECONNREFUSED 127.0.0.1:443)');
  });

  it('reports an undici timeout code', () => {
    const error = fetchFailed(Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    }));

    expect(enrichTransportFailure(error).message).toBe('fetch failed (UND_ERR_CONNECT_TIMEOUT)');
  });

  it('keeps the original object identity so abort detection still works', () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    expect(enrichTransportFailure(abort)).toBe(abort);
    expect(enrichTransportFailure(abort).message).toBe('This operation was aborted');
  });

  it('leaves unrelated errors and causeless failures untouched', () => {
    const other = new Error('upstream said no');
    expect(enrichTransportFailure(other).message).toBe('upstream said no');

    const noCause = new TypeError('fetch failed');
    expect(enrichTransportFailure(noCause).message).toBe('fetch failed');

    expect(enrichTransportFailure('not an error')).toBe('not an error');
  });
});

describe('performFetch stale-connection retry', () => {
  it('retries once when the pooled socket dies before a response arrives', async () => {
    const { createServer } = await import('node:net');
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      if (connections === 1) {
        // Exactly what an upstream closing an idle keep-alive socket looks like.
        socket.destroy();
        return;
      }
      socket.on('data', () => {
        const body = '{"ok":true}';
        socket.write(
          `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
        );
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address() as { port: number };

    try {
      const request = {
        endpoint: 'chat' as const,
        path: '/v1/chat/completions',
        headers: {},
        body: { model: 'm' },
      };
      const response = await performFetch(
        {
          siteUrl: `http://127.0.0.1:${address.port}`,
          request,
          buildInit: () => ({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"model":"m"}',
          }),
        },
        request,
      );

      expect(response.status).toBe(200);
      await expect(readRuntimeResponseText(response)).resolves.toBe('{"ok":true}');
      expect(connections).toBe(2);
    } finally {
      server.close();
    }
  });
});

/**
 * Cascade hops (metapi -> tunnel -> metapi) re-upload the whole prompt. The
 * compression must live in performFetch, the single fetch point every runtime
 * executor shares — wiring it only into endpointFlow's default-fetch branch
 * leaves production chat traffic (which passes a dispatch hook) uncompressed.
 */
describe('performFetch cascade request-body compression', () => {
  it('learns the upstream capability from a response, then gzips the next request', async () => {
    const { createServer } = await import('node:http');
    const received: { headers: Record<string, string | string[] | undefined>; raw: Buffer }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        received.push({ headers: req.headers, raw: Buffer.concat(chunks) });
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-metapi-body-encoding': 'gzip',
        });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ model: 'm', input: 'x'.repeat(50_000) });
    const request = {
      endpoint: 'chat' as const,
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'm' },
    };
    const input = {
      siteUrl: origin,
      request,
      buildInit: () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    };

    const { __resetRequestBodyCompressionForTests } = await import(
      '../../services/requestBodyCompression.js'
    );
    __resetRequestBodyCompressionForTests();
    try {
      // Capability unknown yet: the first request travels plain.
      await performFetch(input, request);
      expect(received[0].headers['content-encoding']).toBeUndefined();
      expect(received[0].raw.toString()).toBe(body);

      // The response advertised support: the next request is gzipped.
      await performFetch(input, request);
      expect(received[1].headers['content-encoding']).toBe('gzip');
      expect(gunzipSync(received[1].raw).toString()).toBe(body);
      expect(received[1].raw.length).toBeLessThan(body.length / 4);
    } finally {
      __resetRequestBodyCompressionForTests();
      server.close();
    }
  });

  it('leaves the body alone for an origin that never advertised support', async () => {
    const { createServer } = await import('node:http');
    let raw = Buffer.alloc(0);
    let sentEncoding: string | undefined;
    const server = createServer((req, res) => {
      sentEncoding = req.headers['content-encoding'] as string | undefined;
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        raw = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    const body = JSON.stringify({ model: 'm', input: 'x'.repeat(50_000) });
    const request = {
      endpoint: 'chat' as const,
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'm' },
    };

    const { __resetRequestBodyCompressionForTests } = await import(
      '../../services/requestBodyCompression.js'
    );
    __resetRequestBodyCompressionForTests();
    try {
      await performFetch(
        {
          siteUrl: `http://127.0.0.1:${port}`,
          request,
          buildInit: () => ({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          }),
        },
        request,
      );
      expect(sentEncoding).toBeUndefined();
      expect(raw.toString()).toBe(body);
    } finally {
      __resetRequestBodyCompressionForTests();
      server.close();
    }
  });
});

/**
 * The striped (parallel-part) upload preludes the request that consumes the
 * body. It must kick in exactly when the origin advertised it AND the compressed
 * body is big enough, and it must vanish — leaving the ordinary compressed
 * single request — the moment any part fails.
 */
describe('performFetch striped request-body upload', () => {
  const buildServer = async (options: { failParts?: boolean } = {}) => {
    const { createServer } = await import('node:http');
    const uploadRequests: { url: string; raw: Buffer }[] = [];
    const realRequests: { headers: Record<string, string | string[] | undefined>; raw: Buffer }[] = [];
    const server = createServer((req, res) => {
      const url = req.url || '';
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        // The upload endpoints live under their own prefix, so one server can
        // play both the part receiver and the upstream without ambiguity.
        if (url.startsWith('/api/v1/peer/body-upload/')) {
          uploadRequests.push({ url, raw });
          res.writeHead(options.failParts ? 500 : 200, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        realRequests.push({ headers: req.headers, raw });
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-metapi-body-encoding': 'gzip',
          'x-metapi-body-upload': 'chunked',
        });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    return { server, origin: `http://127.0.0.1:${port}`, uploadRequests, realRequests };
  };

  // Bandwidth on the tunnel is the point, so the body must stay above the stripe
  // threshold after gzip: random hex compresses to roughly half, so 500 KB of
  // entropy lands near 500 KB compressed — comfortably over MIN_BYTES.
  const buildBody = () => JSON.stringify({ model: 'm', input: randomBytes(500_000).toString('hex') });
  // Below the threshold the body must stay on the single-request path: measured
  // on the real link, striping a ~195 KB body lost to one request.
  const buildSmallBody = () => JSON.stringify({ model: 'm', input: randomBytes(200_000).toString('hex') });

  it('stripes the compressed body when the origin advertised chunked upload', async () => {
    const { server, origin, uploadRequests, realRequests } = await buildServer();
    const body = buildBody();
    const request = {
      endpoint: 'chat' as const,
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'm' },
    };
    const input = {
      siteUrl: origin,
      request,
      buildInit: () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    };

    const { __resetRequestBodyCompressionForTests } = await import(
      '../../services/requestBodyCompression.js'
    );
    __resetRequestBodyCompressionForTests();
    __resetChunkedBodyUploadForTests();
    try {
      // Nothing learned yet: the first request travels plain and the response
      // teaches us both capabilities.
      await performFetch(input, request);
      expect(realRequests).toHaveLength(1);
      expect(realRequests[0].headers['content-encoding']).toBeUndefined();
      expect(realRequests[0].raw.toString()).toBe(body);
      expect(uploadRequests).toHaveLength(0);

      // Both capabilities known: the body is gzipped, uploaded as parallel
      // parts, and the request itself carries only the upload id.
      await performFetch(input, request);
      expect(uploadRequests.length).toBeGreaterThanOrEqual(2);
      const byIndex = new Map<number, Buffer>();
      for (const part of uploadRequests) {
        expect(part.url.startsWith('/api/v1/peer/body-upload/')).toBe(true);
        byIndex.set(Number(part.url.split('/').pop()), part.raw);
      }
      for (let index = 0; index < byIndex.size; index += 1) expect(byIndex.has(index)).toBe(true);
      const assembled = Buffer.concat(
        [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, chunk]) => chunk),
      );
      expect(gunzipSync(assembled).toString()).toBe(body);

      expect(realRequests).toHaveLength(2);
      const finalRequest = realRequests[1];
      expect(finalRequest.headers['x-metapi-body-upload-id']).toBeDefined();
      expect(finalRequest.headers['content-encoding']).toBeUndefined();
      expect(finalRequest.headers['content-type']).toBe('application/json');
      expect(finalRequest.raw.length).toBe(0);
    } finally {
      __resetRequestBodyCompressionForTests();
      __resetChunkedBodyUploadForTests();
      server.close();
    }
  });

  it('keeps a body below the stripe threshold on the single-request path', async () => {
    const { server, origin, uploadRequests, realRequests } = await buildServer();
    const body = buildSmallBody();
    const request = {
      endpoint: 'chat' as const,
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'm' },
    };
    const input = {
      siteUrl: origin,
      request,
      buildInit: () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    };

    const { __resetRequestBodyCompressionForTests } = await import(
      '../../services/requestBodyCompression.js'
    );
    __resetRequestBodyCompressionForTests();
    __resetChunkedBodyUploadForTests();
    try {
      await performFetch(input, request);
      // Capabilities are known now, but the body is under MIN_BYTES.
      const uploadsBefore = uploadRequests.length;
      await performFetch(input, request);

      expect(uploadRequests.length).toBe(uploadsBefore);
      const lastRequest = realRequests[realRequests.length - 1];
      expect(lastRequest.headers['x-metapi-body-upload-id']).toBeUndefined();
      // The ordinary compressed single request instead.
      expect(lastRequest.headers['content-encoding']).toBe('gzip');
      expect(lastRequest.raw.length).toBeGreaterThan(0);
      expect(gunzipSync(lastRequest.raw).toString()).toBe(body);
    } finally {
      __resetRequestBodyCompressionForTests();
      __resetChunkedBodyUploadForTests();
      server.close();
    }
  });

  it('falls back to the single compressed request when a part upload fails', async () => {
    const { server, origin, uploadRequests, realRequests } = await buildServer({ failParts: true });
    const body = buildBody();
    const request = {
      endpoint: 'chat' as const,
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'm' },
    };
    const input = {
      siteUrl: origin,
      request,
      buildInit: () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    };

    const { __resetRequestBodyCompressionForTests } = await import(
      '../../services/requestBodyCompression.js'
    );
    __resetRequestBodyCompressionForTests();
    __resetChunkedBodyUploadForTests();
    try {
      await performFetch(input, request);
      expect(realRequests[0].raw.toString()).toBe(body);

      // Parts answer 500: the upload must return null and the hop must still
      // send the ordinary gzipped single request.
      await performFetch(input, request);
      expect(uploadRequests.length).toBeGreaterThan(0);
      expect(realRequests).toHaveLength(2);
      const finalRequest = realRequests[1];
      expect(finalRequest.headers['x-metapi-body-upload-id']).toBeUndefined();
      expect(finalRequest.headers['content-encoding']).toBe('gzip');
      expect(gunzipSync(finalRequest.raw).toString()).toBe(body);
    } finally {
      __resetRequestBodyCompressionForTests();
      __resetChunkedBodyUploadForTests();
      server.close();
    }
  });
});

/**
 * Sender side of the prefix delta: after one full body the next turn travels as
 * a suffix, and a 409 from the peer must transparently become a full resend.
 */
describe('performFetch cascade prefix-delta', () => {
  it('sends only the suffix after the peer advertised delta bodies', async () => {
    const { createServer } = await import('node:http');
    const received: { headers: Record<string, string | string[] | undefined>; raw: Buffer }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        received.push({ headers: req.headers, raw: Buffer.concat(chunks) });
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-metapi-body-delta': 'v1',
          'x-metapi-body-encoding': 'gzip',
        });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const messages = [{ role: 'user', content: 'x'.repeat(200_000) }];
    const full = JSON.stringify({ model: 'm', messages });
    const grown = JSON.stringify({
      model: 'm',
      messages: [...messages, { role: 'assistant', content: 'ok' }],
    });
    const request = {
      endpoint: 'chat' as const,
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'm' },
    };
    let body = full;
    const input = {
      siteUrl: origin,
      request,
      buildInit: () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-hop' },
        body,
      }),
    };

    const { __resetRequestBodyCompressionForTests } = await import(
      '../../services/requestBodyCompression.js'
    );
    const { __resetRequestBodyDeltaForTests } = await import(
      '../../services/requestBodyDelta.js'
    );
    __resetRequestBodyCompressionForTests();
    __resetRequestBodyDeltaForTests();
    try {
      await performFetch(input, request);
      expect(received[0].headers['x-metapi-body-delta-base']).toBeUndefined();
      expect(received[0].raw.toString()).toBe(full);

      // The first response taught the sender the capability; this full body is
      // marked so the peer keeps it for the next turn.
      await performFetch(input, request);
      expect(received[1].headers['x-metapi-body-store']).toBe('1');
      expect(
        received[1].headers['content-encoding'] === 'gzip'
          ? gunzipSync(received[1].raw).toString()
          : received[1].raw.toString(),
      ).toBe(full);

      body = grown;
      await performFetch(input, request);
      const deltaHeaders = received[2].headers;
      expect(deltaHeaders['x-metapi-body-delta-base']).toBeDefined();
      expect(deltaHeaders['x-metapi-body-delta-sha256']).toBeDefined();
      const prefix = Number(deltaHeaders['x-metapi-body-delta-prefix']);
      expect(prefix).toBeGreaterThan(200_000);
      // A tiny suffix stays uncompressed (below the 4 KB compression floor);
      // either way it is only the bytes after the prefix.
      const sent = received[2].headers['content-encoding'] === 'gzip'
        ? gunzipSync(received[2].raw)
        : received[2].raw;
      expect(sent.toString()).toBe(grown.slice(prefix));
      expect(received[2].raw.length).toBeLessThan(Buffer.byteLength(grown) / 5);
    } finally {
      __resetRequestBodyCompressionForTests();
      __resetRequestBodyDeltaForTests();
      server.close();
    }
  });

  it('resends the full body once when the peer answers 409 delta miss', async () => {
    const { createServer } = await import('node:http');
    const received: { headers: Record<string, string | string[] | undefined>; raw: Buffer }[] = [];
    let missNextDelta = false;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        received.push({ headers: req.headers, raw: Buffer.concat(chunks) });
        if (missNextDelta && req.headers['x-metapi-body-delta-base']) {
          missNextDelta = false;
          res.writeHead(409, { 'content-type': 'application/json', 'x-metapi-body-delta': 'miss' });
          res.end('{"error":"miss"}');
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-metapi-body-delta': 'v1',
          'x-metapi-body-encoding': 'gzip',
        });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const messages = [{ role: 'user', content: 'q'.repeat(200_000) }];
    const full = JSON.stringify({ model: 'm', messages });
    const grown = JSON.stringify({ model: 'm', messages: [...messages, { role: 'user', content: 'next' }] });
    const request = {
      endpoint: 'chat' as const,
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'm' },
    };
    let body = full;
    const input = {
      siteUrl: origin,
      request,
      buildInit: () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-hop' },
        body,
      }),
    };

    const { __resetRequestBodyCompressionForTests } = await import(
      '../../services/requestBodyCompression.js'
    );
    const { __resetRequestBodyDeltaForTests } = await import(
      '../../services/requestBodyDelta.js'
    );
    __resetRequestBodyCompressionForTests();
    __resetRequestBodyDeltaForTests();
    try {
      await performFetch(input, request);
      await performFetch(input, request);
      body = grown;
      missNextDelta = true;
      const response = await performFetch(input, request);

      expect(response.status).toBe(200);
      // Four requests: full, full+store, delta (409), full again.
      expect(received).toHaveLength(4);
      expect(received[2].headers['x-metapi-body-delta-base']).toBeDefined();
      expect(received[3].headers['x-metapi-body-delta-base']).toBeUndefined();
      expect(gunzipSync(received[3].raw).toString()).toBe(grown);
    } finally {
      __resetRequestBodyCompressionForTests();
      __resetRequestBodyDeltaForTests();
      server.close();
    }
  });
});
