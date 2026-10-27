import { createHash, randomBytes } from 'node:crypto';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REQUEST_BODY_ENCODING_CAPABILITY_HEADER,
  __resetRequestBodyCompressionForTests,
  __setMaxCompressedRequestBodyBytesForTests,
  __setMaxDecompressedRequestBodyBytesForTests,
  advertisedRequestBodyEncodings,
  parseRequestBodyEncoding,
  registerCompressedRequestBodySupport,
} from './requestBodyCompression.js';
import {
  REQUEST_BODY_UPLOAD_ENCODING_HEADER,
  REQUEST_BODY_UPLOAD_ID_HEADER,
  REQUEST_BODY_UPLOAD_PART_COUNT_HEADER,
  REQUEST_BODY_UPLOAD_PART_INDEX_HEADER,
  REQUEST_BODY_UPLOAD_ROUTE_PREFIX,
  REQUEST_BODY_UPLOAD_SHA256_HEADER,
  __resetChunkedBodyUploadForTests,
  registerChunkedBodyUploadRoutes,
  storeUploadedBodyPart,
} from './requestBodyChunkedUpload.js';
import { config } from '../config.js';

/**
 * Receiver side of the cascade-hop body compression: a cascaded instance sends
 * the prompt compressed, this instance must decode it exactly like plain JSON
 * and advertise which encodings it can decode so the sender knows what it may
 * use.
 */
describe('compressed request body support (receiver)', () => {
  const apps: FastifyInstance[] = [];

  const build = async () => {
    const app = Fastify();
    registerCompressedRequestBodySupport(app);
    app.post('/v1/chat/completions', async (request) => ({
      ok: true,
      body: request.body ?? null,
    }));
    apps.push(app);
    await app.ready();
    return app;
  };

  beforeEach(() => {
    __resetRequestBodyCompressionForTests();
    __resetChunkedBodyUploadForTests();
  });

  afterEach(async () => {
    __resetRequestBodyCompressionForTests();
    __resetChunkedBodyUploadForTests();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('advertises every decodable encoding on responses', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers[REQUEST_BODY_ENCODING_CAPABILITY_HEADER]).toBe(
      advertisedRequestBodyEncodings().join(', '),
    );
    expect(String(response.headers[REQUEST_BODY_ENCODING_CAPABILITY_HEADER])).toContain('gzip');
  });

  it('parses a gzip request body exactly like the plain one', async () => {
    const app = await build();
    const body = { model: 'm', messages: [{ role: 'user', content: '你好'.repeat(500) }] };

    const plain = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    const compressed = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipSync(Buffer.from(JSON.stringify(body))),
    });

    expect(compressed.statusCode).toBe(200);
    expect(compressed.json()).toEqual(plain.json());
    expect(compressed.json().body).toEqual(body);
  });

  it('parses a zstd request body exactly like the plain one', async () => {
    const app = await build();
    const body = { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(40_000) }] };

    const plain = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    const compressed = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      payload: zstdCompressSync(Buffer.from(JSON.stringify(body))),
    });

    expect(compressed.statusCode).toBe(200);
    expect(compressed.json()).toEqual(plain.json());
    expect(compressed.json().body).toEqual(body);
  });

  it('reassembles a striped upload into the same body as the plain request', async () => {
    const app = await build();
    const body = { model: 'm', messages: [{ role: 'user', content: '分片上传'.repeat(500) }] };
    const compressed = gzipSync(Buffer.from(JSON.stringify(body)));
    const sha256 = createHash('sha256').update(compressed).digest('hex');
    const half = Math.ceil(compressed.length / 2);
    const uploadId = 'receiver-striped-body';
    expect(storeUploadedBodyPart({
      uploadId,
      index: 0,
      partCount: 2,
      sha256,
      encoding: 'gzip',
      bytes: compressed.subarray(0, half),
    })).toEqual({ ok: true });
    expect(storeUploadedBodyPart({
      uploadId,
      index: 1,
      partCount: 2,
      sha256,
      encoding: 'gzip',
      bytes: compressed.subarray(half),
    })).toEqual({ ok: true });

    const plain = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    // The consuming request carries only the id (empty body): the payload
    // travelled in the parallel parts stored above.
    const striped = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', [REQUEST_BODY_UPLOAD_ID_HEADER]: uploadId },
      payload: '',
    });

    expect(striped.statusCode).toBe(200);
    expect(striped.json()).toEqual(plain.json());
    expect(striped.json().body).toEqual(body);
  });

  it('answers 400 for an unknown or incomplete striped upload id', async () => {
    const app = await build();
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', [REQUEST_BODY_UPLOAD_ID_HEADER]: 'never-seen' },
      payload: '',
    });
    expect(unknown.statusCode).toBe(400);

    // A single stored part of two is an incomplete body: same 400, never a
    // half-decoded payload handed to the parser.
    const compressed = gzipSync(Buffer.from(JSON.stringify({ model: 'm' })));
    const sha256 = createHash('sha256').update(compressed).digest('hex');
    storeUploadedBodyPart({
      uploadId: 'only-one-part',
      index: 0,
      partCount: 2,
      sha256,
      encoding: 'gzip',
      bytes: compressed.subarray(0, Math.ceil(compressed.length / 2)),
    });
    const incomplete = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', [REQUEST_BODY_UPLOAD_ID_HEADER]: 'only-one-part' },
      payload: '',
    });
    expect(incomplete.statusCode).toBe(400);
  });

  it('rejects a compressed body that decompresses past the limit', async () => {
    const app = await build();
    __setMaxDecompressedRequestBodyBytesForTests(1024);
    const payload = JSON.stringify({ blob: 'x'.repeat(50_000) });
    const limited = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        payload: gzipSync(Buffer.from(payload)),
      }),
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
        payload: zstdCompressSync(Buffer.from(payload)),
      }),
    ]);
    expect(limited.map((response) => response.statusCode)).toEqual([413, 413]);
  });

  it('rejects bodies that are not valid gzip or zstd', async () => {
    const app = await build();
    const responses = await Promise.all(['gzip', 'zstd'].map((contentEncoding) =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-encoding': contentEncoding },
        payload: Buffer.from(`definitely not ${contentEncoding}`),
      }),
    ));
    for (const response of responses) expect(response.statusCode).toBe(400);
  });

  it('does not intercept encodings it cannot decode', async () => {
    const app = await build();
    // `br` is not ours to decode: the hook leaves the payload alone and the JSON
    // parser then sees still-encoded bytes, which it rejects as an invalid body.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      payload: Buffer.from('whatever'),
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a compressed body larger than the compressed-input cap', async () => {
    const app = await build();
    __setMaxCompressedRequestBodyBytesForTests(1024);
    // 不可压缩内容，保证"压缩后仍然很大"，测的是缓冲上限而不是解码失败。
    const payload = gzipSync(Buffer.from(JSON.stringify({ blob: randomBytes(200_000).toString('latin1') })));
    expect(payload.length).toBeGreaterThan(1024);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload,
    });
    expect(response.statusCode).toBe(413);
  });

  it('answers 400 for an empty body that claims to be compressed', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: Buffer.alloc(0),
    });
    expect(response.statusCode).toBe(400);
  });

  /**
   * Decoding used to happen by piping a zlib stream into the parser and
   * destroying the returned stream on failure. When that error fired while
   * nothing was listening yet (malformed body, client gone), it escaped as an
   * unhandled 'error' event and took the process down — reachable
   * unauthenticated over the tunnel. The hook now buffers, decodes, and rejects,
   * so no error can travel on a stream we no longer own.
   */
  it('never lets a decode failure escape as an unhandled stream error', async () => {
    const app = await build();
    const cases = [
      { encoding: 'gzip', payload: Buffer.from('definitely not gzip') },
      { encoding: 'zstd', payload: Buffer.from('definitely not zstd') },
      { encoding: 'gzip', payload: gzipSync(Buffer.from('{}')).subarray(0, 6) },
      { encoding: 'gzip', payload: Buffer.alloc(0) },
    ];
    for (const c of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-encoding': c.encoding },
        payload: c.payload,
      });
      expect([400, 413]).toContain(response.statusCode);
    }
  });

  /**
   * Fastify runs onSend hooks LIFO, so a plugin registered later (in this repo
   * @fastify/compress) can commit the response first. Setting a header at that
   * point throws ERR_HTTP_HEADERS_SENT, which the peer observed as a 500 log on
   * every cascade-key call while the client still got a 200.
   */
  it('skips the capability header when an earlier onSend hook already committed the response', async () => {
    const logged: string[] = [];
    const app = Fastify({ logger: { level: 'error', stream: { write: (chunk) => logged.push(String(chunk)) } } });
    registerCompressedRequestBodySupport(app);
    // Registered after ours, so Fastify runs it first (onSend is LIFO) and it
    // commits the response before our hook could set a header — the shape
    // @fastify/compress has in production.
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.raw.writeHead(200, { 'content-type': 'text/plain' });
      reply.raw.end('ok');
      return payload;
    });
    app.get('/committed', async () => ({ ok: true }));
    apps.push(app);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/committed' });
    expect(response.statusCode).toBe(200);
    // The artificial committing hook also makes Fastify's own send path complain,
    // so assert on the culprit instead of the message: only our module setting a
    // header after the response was committed points at requestBodyCompression.
    expect(logged.join('')).not.toMatch(/requestBodyCompression/);
  });

  it('reads a single encoding token, and refuses to half-decode a chain', () => {
    expect(parseRequestBodyEncoding('gzip')).toBe('gzip');
    expect(parseRequestBodyEncoding(' zstd ')).toBe('zstd');
    expect(parseRequestBodyEncoding('x-gzip')).toBe('gzip');
    expect(parseRequestBodyEncoding('identity')).toBeNull();
    expect(parseRequestBodyEncoding('br, deflate')).toBeNull();
    // A chain would need reverse-order decoding; we must not do half of it.
    expect(parseRequestBodyEncoding('gzip, zstd')).toBeNull();
    expect(parseRequestBodyEncoding(undefined)).toBeNull();
  });

  /**
   * Regression: production mounts both plugins on one app (index.ts registers
   * compression support, then the upload routes). The compression hook keys on
   * the upload-id header — the placeholder request's signal — and used to
   * intercept striped-upload parts carrying that header (any sender built
   * before the header was dropped) and reject every one of them with 400
   * "Uploaded request body is missing or incomplete". Parts must go straight
   * to their route in both header shapes; only the placeholder may assemble.
   */
  it('keeps striped-upload parts out of the compression hook in both header shapes', async () => {
    (config as { authToken: string }).authToken = 'striped-route-regression-token';
    const app = Fastify();
    registerCompressedRequestBodySupport(app);
    registerChunkedBodyUploadRoutes(app);
    app.post('/v1/chat/completions', async (request) => ({ ok: true, body: request.body ?? null }));
    apps.push(app);
    await app.ready();

    const original = { model: 'm', messages: [{ role: 'user', content: `分片 ${'x'.repeat(4000)}` }] };
    const compressed = gzipSync(Buffer.from(JSON.stringify(original)));
    const sha = createHash('sha256').update(compressed).digest('hex');
    const uploadId = randomBytes(16).toString('hex');
    const half = Math.ceil(compressed.length / 2);
    const parts = [
      { index: 0, bytes: compressed.subarray(0, half), withIdHeader: true },
      { index: 1, bytes: compressed.subarray(half), withIdHeader: false },
    ];
    for (const part of parts) {
      const headers: Record<string, string> = {
        authorization: 'Bearer striped-route-regression-token',
        'content-type': 'application/octet-stream',
        [REQUEST_BODY_UPLOAD_PART_INDEX_HEADER]: String(part.index),
        [REQUEST_BODY_UPLOAD_PART_COUNT_HEADER]: '2',
        [REQUEST_BODY_UPLOAD_SHA256_HEADER]: sha,
        [REQUEST_BODY_UPLOAD_ENCODING_HEADER]: 'gzip',
      };
      if (part.withIdHeader) headers[REQUEST_BODY_UPLOAD_ID_HEADER] = uploadId;
      const response = await app.inject({
        method: 'POST',
        url: `${REQUEST_BODY_UPLOAD_ROUTE_PREFIX}/${uploadId}/${part.index}`,
        headers,
        payload: part.bytes,
      });
      expect(response.statusCode).toBe(200);
    }

    // The placeholder still reassembles: the route sees the decoded JSON body.
    const assembled = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer striped-route-regression-token',
        'content-type': 'application/json',
        [REQUEST_BODY_UPLOAD_ID_HEADER]: uploadId,
      },
      payload: '',
    });
    expect(assembled.statusCode).toBe(200);
    expect(assembled.json()).toEqual({ ok: true, body: original });

    // Unknown id still fails loudly instead of reaching the route body-less.
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        [REQUEST_BODY_UPLOAD_ID_HEADER]: 'deadbeef'.repeat(4),
      },
      payload: '',
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toBe('Uploaded request body is missing or incomplete');
  });
});
