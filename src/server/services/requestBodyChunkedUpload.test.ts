import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import {
  REQUEST_BODY_UPLOAD_CAPABILITY_HEADER,
  REQUEST_BODY_UPLOAD_CHUNKED_VALUE,
  REQUEST_BODY_UPLOAD_ENCODING_HEADER,
  REQUEST_BODY_UPLOAD_ID_HEADER,
  REQUEST_BODY_UPLOAD_MAX_TOTAL_BYTES,
  REQUEST_BODY_UPLOAD_MAX_PENDING_UPLOADS,
  REQUEST_BODY_UPLOAD_MIN_BYTES,
  REQUEST_BODY_UPLOAD_PART_COUNT_HEADER,
  REQUEST_BODY_UPLOAD_PART_INDEX_HEADER,
  REQUEST_BODY_UPLOAD_ROUTE_PREFIX,
  REQUEST_BODY_UPLOAD_SHA256_HEADER,
  __getChunkedBodyUploadStatsForTests,
  __resetChunkedBodyUploadForTests,
  __setChunkedBodyUploadTtlForTests,
  assembleUploadedBody,
  buildBodyUploadBaseUrl,
  learnUpstreamBodyUploadCapability,
  registerChunkedBodyUploadRoutes,
  shouldStripeRequestBody,
  storeUploadedBodyPart,
  supportsChunkedBodyUpload,
  uploadRequestBodyInParts,
  type BodyUploadFetch,
} from './requestBodyChunkedUpload.js';

/**
 * Striped request-body upload between cascaded instances: the sender splits a
 * compressed body into parallel parts (the tunnel throttles per stream, so N
 * streams roughly double the rate), the receiver reassembles them exactly.
 */

const TEST_TOKEN = 'chunked-upload-test-token';
const ORIGIN = 'https://peer.example';

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function partsOf(body: Buffer, partCount: number, digest: string, encoding = 'gzip') {
  const partSize = Math.ceil(body.length / partCount);
  return Array.from({ length: partCount }, (_unused, index) => ({
    index,
    partCount,
    sha256: digest,
    encoding,
    bytes: body.subarray(index * partSize, Math.min((index + 1) * partSize, body.length)),
  }));
}

describe('striped request body upload', () => {
  const apps: FastifyInstance[] = [];

  beforeAll(() => {
    // config is a build-time singleton; pin the admin token for the route tests.
    (config as { authToken: string }).authToken = TEST_TOKEN;
  });

  beforeEach(() => __resetChunkedBodyUploadForTests());

  afterEach(async () => {
    __resetChunkedBodyUploadForTests();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  const buildApp = async () => {
    const app = Fastify();
    registerChunkedBodyUploadRoutes(app);
    app.get('/ping', async () => ({ ok: true }));
    // Deliberately outside the upload plugin's scope: it must not inherit the
    // upload route's media type parser.
    app.post('/v1/chat/completions', async (request) => ({ ok: true, body: request.body ?? null }));
    apps.push(app);
    await app.ready();
    return app;
  };

  describe('receiver storage', () => {
    it('assembles parts that arrive out of order', () => {
      const body = randomBytes(150_000);
      const [first, second, third] = partsOf(body, 3, sha256(body));
      for (const part of [third, first, second]) {
        expect(storeUploadedBodyPart({ uploadId: 'u-out-of-order', ...part })).toEqual({ ok: true });
      }
      expect(__getChunkedBodyUploadStatsForTests()).toEqual({
        pendingUploads: 1,
        bufferedBytes: body.length,
      });

      const assembled = assembleUploadedBody('u-out-of-order');
      expect(assembled?.encoding).toBe('gzip');
      expect(assembled?.compressed.equals(body)).toBe(true);
      // The upload is consumed: a second call cannot replay the same bytes.
      expect(assembleUploadedBody('u-out-of-order')).toBeNull();
      expect(__getChunkedBodyUploadStatsForTests()).toEqual({ pendingUploads: 0, bufferedBytes: 0 });
    });

    it('refuses a repeated part index', () => {
      const body = randomBytes(140_000);
      const parts = partsOf(body, 2, sha256(body));
      expect(storeUploadedBodyPart({ uploadId: 'u-dup', ...parts[0] })).toEqual({ ok: true });

      const duplicate = storeUploadedBodyPart({ uploadId: 'u-dup', ...parts[0] });
      expect(duplicate.ok).toBe(false);
      expect(duplicate.ok === false && duplicate.statusCode).toBe(409);
    });

    it('refuses an index outside the declared part count', () => {
      const body = randomBytes(140_000);
      const parts = partsOf(body, 2, sha256(body));
      const outOfRange = storeUploadedBodyPart({
        uploadId: 'u-range',
        index: 2,
        partCount: 2,
        sha256: sha256(body),
        encoding: 'gzip',
        bytes: parts[1].bytes,
      });
      expect(outOfRange.ok).toBe(false);
      expect(outOfRange.ok === false && outOfRange.statusCode).toBe(400);
    });

    it('refuses parts that would exceed the buffered-bytes cap', () => {
      const oversized = Buffer.allocUnsafe(REQUEST_BODY_UPLOAD_MAX_TOTAL_BYTES + 1);
      const rejected = storeUploadedBodyPart({
        uploadId: 'u-huge',
        index: 0,
        partCount: 2,
        sha256: 'a'.repeat(64),
        encoding: 'gzip',
        bytes: oversized,
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.ok === false && rejected.statusCode).toBe(413);
      expect(__getChunkedBodyUploadStatsForTests()).toEqual({ pendingUploads: 0, bufferedBytes: 0 });
    });

    it('applies the buffered-bytes cap to newly created uploads too', () => {
      // Regression: the cap used to be checked only when appending to an
      // existing upload, so every fresh uploadId started its own 32MB budget
      // and a single downstream key could exhaust process memory.
      const partSize = Math.floor(REQUEST_BODY_UPLOAD_MAX_TOTAL_BYTES * 0.6);
      const first = storeUploadedBodyPart({
        uploadId: 'u-global-1',
        index: 0,
        partCount: 2,
        sha256: 'a'.repeat(64),
        encoding: 'gzip',
        bytes: Buffer.allocUnsafe(partSize),
      });
      expect(first).toEqual({ ok: true });

      const second = storeUploadedBodyPart({
        uploadId: 'u-global-2',
        index: 0,
        partCount: 2,
        sha256: 'b'.repeat(64),
        encoding: 'gzip',
        bytes: Buffer.allocUnsafe(partSize),
      });
      expect(second.ok).toBe(false);
      expect(second.ok === false && second.statusCode).toBe(413);
    });

    it('caps the number of concurrently pending uploads', () => {
      for (let i = 0; i < REQUEST_BODY_UPLOAD_MAX_PENDING_UPLOADS; i += 1) {
        expect(storeUploadedBodyPart({
          uploadId: `u-many-${i}`,
          index: 0,
          partCount: 2,
          sha256: 'c'.repeat(64),
          encoding: 'gzip',
          bytes: Buffer.from([i % 256]),
        })).toEqual({ ok: true });
      }

      const overflow = storeUploadedBodyPart({
        uploadId: 'u-many-overflow',
        index: 0,
        partCount: 2,
        sha256: 'd'.repeat(64),
        encoding: 'gzip',
        bytes: Buffer.from([0]),
      });
      expect(overflow.ok).toBe(false);
      expect(overflow.ok === false && overflow.statusCode).toBe(429);
    });

    it('drops an upload whose digest does not match the assembled body', () => {
      const body = randomBytes(140_000);
      const parts = partsOf(body, 2, sha256(Buffer.from('a different body')));
      for (const part of parts) {
        expect(storeUploadedBodyPart({ uploadId: 'u-bad-digest', ...part })).toEqual({ ok: true });
      }
      expect(assembleUploadedBody('u-bad-digest')).toBeNull();
      expect(__getChunkedBodyUploadStatsForTests()).toEqual({ pendingUploads: 0, bufferedBytes: 0 });
    });

    it('returns null for an unknown upload id', () => {
      expect(assembleUploadedBody('never-seen')).toBeNull();
    });

    it('returns null once the upload has outlived its TTL', async () => {
      const body = randomBytes(140_000);
      const parts = partsOf(body, 2, sha256(body));
      __setChunkedBodyUploadTtlForTests(5);
      for (const part of parts) {
        expect(storeUploadedBodyPart({ uploadId: 'u-ttl', ...part })).toEqual({ ok: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(assembleUploadedBody('u-ttl')).toBeNull();
      expect(__getChunkedBodyUploadStatsForTests()).toEqual({ pendingUploads: 0, bufferedBytes: 0 });
    });

    it('reports a part of an incomplete upload as null', () => {
      const body = randomBytes(140_000);
      const parts = partsOf(body, 2, sha256(body));
      expect(storeUploadedBodyPart({ uploadId: 'u-partial', ...parts[0] })).toEqual({ ok: true });
      expect(assembleUploadedBody('u-partial')).toBeNull();
      expect(__getChunkedBodyUploadStatsForTests()).toEqual({ pendingUploads: 0, bufferedBytes: 0 });
    });
  });

  describe('receiver route', () => {
    const partHeaders = (meta: { uploadId: string; index: number; partCount: number; sha256: string }) => ({
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/octet-stream',
      [REQUEST_BODY_UPLOAD_ID_HEADER]: meta.uploadId,
      [REQUEST_BODY_UPLOAD_PART_INDEX_HEADER]: String(meta.index),
      [REQUEST_BODY_UPLOAD_PART_COUNT_HEADER]: String(meta.partCount),
      [REQUEST_BODY_UPLOAD_SHA256_HEADER]: meta.sha256,
      [REQUEST_BODY_UPLOAD_ENCODING_HEADER]: 'gzip',
    });

    it('answers a bare 401 without a token, and without buffering the part', async () => {
      const app = await buildApp();
      const response = await app.inject({
        method: 'POST',
        url: `${REQUEST_BODY_UPLOAD_ROUTE_PREFIX}/u-401/0`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.from('part'),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Invalid token' });
      // The credential is settled before the handler runs, so a refused part
      // never reaches the buffer (neither the admin token nor a downstream key
      // was presented here).
      expect(__getChunkedBodyUploadStatsForTests()).toEqual({ pendingUploads: 0, bufferedBytes: 0 });
    });

    it('advertises the capability on every response', async () => {
      const app = await buildApp();
      const response = await app.inject({ method: 'GET', url: '/ping' });
      expect(response.statusCode).toBe(200);
      expect(response.headers[REQUEST_BODY_UPLOAD_CAPABILITY_HEADER]).toBe(
        REQUEST_BODY_UPLOAD_CHUNKED_VALUE,
      );
    });

    it('accepts every part and reassembles the body', async () => {
      const app = await buildApp();
      const body = randomBytes(REQUEST_BODY_UPLOAD_MIN_BYTES * 3);
      const parts = partsOf(body, 3, sha256(body));

      for (const part of parts) {
        const response = await app.inject({
          method: 'POST',
          url: `${REQUEST_BODY_UPLOAD_ROUTE_PREFIX}/u-route/${part.index}`,
          headers: partHeaders({ uploadId: 'u-route', ...part }),
          payload: part.bytes,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
      }

      const assembled = assembleUploadedBody('u-route');
      expect(assembled?.compressed.equals(body)).toBe(true);
      expect(assembled?.encoding).toBe('gzip');
    });

    it('answers 400 when the index header disagrees with the URL', async () => {
      const app = await buildApp();
      const body = randomBytes(140_000);
      const parts = partsOf(body, 2, sha256(body));
      const response = await app.inject({
        method: 'POST',
        url: `${REQUEST_BODY_UPLOAD_ROUTE_PREFIX}/u-mismatch/0`,
        headers: partHeaders({
          uploadId: 'u-mismatch',
          index: 1,
          partCount: parts[1].partCount,
          sha256: parts[1].sha256,
        }),
        payload: parts[0].bytes,
      });
      expect(response.statusCode).toBe(400);
    });

    it('leaves other routes on their own media type handling', async () => {
      const app = await buildApp();
      const json = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ model: 'm' }),
      });
      expect(json.statusCode).toBe(200);
      expect(json.json().body).toEqual({ model: 'm' });

      const alien = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.from('not json'),
      });
      expect(alien.statusCode).toBe(415);
    });
  });

  describe('sender capability learning', () => {
    it('learns the capability from a chunked response and ignores responses without it', () => {
      learnUpstreamBodyUploadCapability(ORIGIN, { headers: { get: () => null } });
      expect(supportsChunkedBodyUpload(ORIGIN)).toBe(false);
      expect(shouldStripeRequestBody({ origin: ORIGIN, byteLength: REQUEST_BODY_UPLOAD_MIN_BYTES })).toBe(false);

      learnUpstreamBodyUploadCapability(ORIGIN, {
        headers: { get: (name) => (name === REQUEST_BODY_UPLOAD_CAPABILITY_HEADER ? 'chunked' : null) },
      });
      expect(supportsChunkedBodyUpload(ORIGIN)).toBe(true);

      // An unpatched peer's (or an unrelated) response is not a downgrade.
      learnUpstreamBodyUploadCapability(ORIGIN, { headers: { get: () => 'gzip' } });
      expect(supportsChunkedBodyUpload(ORIGIN)).toBe(true);

      expect(supportsChunkedBodyUpload(null)).toBe(false);
      expect(supportsChunkedBodyUpload('https://other.example')).toBe(false);
    });
  });

  describe('sender striping', () => {
    const calls: { url: string; headers: Record<string, string>; body: Uint8Array }[] = [];
    const okFetch: BodyUploadFetch = (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve({ ok: true, status: 200 });
    };

    beforeEach(() => {
      calls.length = 0;
      learnUpstreamBodyUploadCapability(ORIGIN, {
        headers: { get: (name) => (name === REQUEST_BODY_UPLOAD_CAPABILITY_HEADER ? 'chunked' : null) },
      });
    });

    it('derives the upload base url from the request url', () => {
      expect(buildBodyUploadBaseUrl(`${ORIGIN}/v1/chat/completions`)).toBe(
        `${ORIGIN}${REQUEST_BODY_UPLOAD_ROUTE_PREFIX}`,
      );
      expect(buildBodyUploadBaseUrl('https://peer.example:8443/v1/messages')).toBe(
        `https://peer.example:8443${REQUEST_BODY_UPLOAD_ROUTE_PREFIX}`,
      );
      expect(buildBodyUploadBaseUrl('not a url')).toBeNull();
    });

    it('only stripes bodies at or above the threshold', () => {
      expect(shouldStripeRequestBody({ origin: ORIGIN, byteLength: REQUEST_BODY_UPLOAD_MIN_BYTES - 1 })).toBe(false);
      expect(shouldStripeRequestBody({ origin: ORIGIN, byteLength: REQUEST_BODY_UPLOAD_MIN_BYTES })).toBe(true);
      expect(shouldStripeRequestBody({ origin: null, byteLength: 10 * REQUEST_BODY_UPLOAD_MIN_BYTES })).toBe(false);
    });

    it('sends four parts that reassemble into the original compressed body', async () => {
      const compressedBody = randomBytes(REQUEST_BODY_UPLOAD_MIN_BYTES * 4);
      const result = await uploadRequestBodyInParts({
        url: `${ORIGIN}/v1/chat/completions`,
        headers: {
          authorization: 'Bearer sk-downstream',
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': String(compressedBody.length),
        },
        compressedBody,
        encoding: 'gzip',
        fetchImpl: okFetch,
      });

      expect(result).not.toBeNull();
      expect(calls).toHaveLength(4);
      const uploadId = result?.uploadId ?? '';
      const ordered = [...calls].sort(
        (left, right) =>
          Number(left.headers[REQUEST_BODY_UPLOAD_PART_INDEX_HEADER])
          - Number(right.headers[REQUEST_BODY_UPLOAD_PART_INDEX_HEADER]),
      );
      for (const [index, call] of ordered.entries()) {
        expect(call.url).toBe(`${ORIGIN}${REQUEST_BODY_UPLOAD_ROUTE_PREFIX}/${uploadId}/${index}`);
        // The id travels in the URL only: stamping it on a part made the
        // receiver's compression hook treat every part as the placeholder and
        // reject it with 400 "Uploaded request body is missing or incomplete".
        expect(call.headers[REQUEST_BODY_UPLOAD_ID_HEADER]).toBeUndefined();
        expect(call.headers[REQUEST_BODY_UPLOAD_PART_INDEX_HEADER]).toBe(String(index));
        expect(call.headers[REQUEST_BODY_UPLOAD_PART_COUNT_HEADER]).toBe('4');
        expect(call.headers[REQUEST_BODY_UPLOAD_SHA256_HEADER]).toBe(sha256(compressedBody));
        expect(call.headers[REQUEST_BODY_UPLOAD_ENCODING_HEADER]).toBe('gzip');
        // The part body is raw bytes: the whole body's coding and length must
        // not survive onto it.
        expect(call.headers['content-type']).toBe('application/octet-stream');
        expect(call.headers['content-encoding']).toBeUndefined();
        expect(call.headers['content-length']).toBeUndefined();
        // Auth and the rest of the caller's headers still travel with the part.
        expect(call.headers.authorization).toBe('Bearer sk-downstream');
      }

      const reassembled = Buffer.concat(ordered.map((call) => Buffer.from(call.body)));
      expect(reassembled.equals(compressedBody)).toBe(true);
    });

    it('sends nothing when the origin never advertised the capability', async () => {
      __resetChunkedBodyUploadForTests();
      const compressedBody = randomBytes(REQUEST_BODY_UPLOAD_MIN_BYTES * 4);
      const result = await uploadRequestBodyInParts({
        url: `${ORIGIN}/v1/chat/completions`,
        headers: {},
        compressedBody,
        encoding: 'gzip',
        fetchImpl: okFetch,
      });
      expect(result).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('sends nothing when the body is below the threshold', async () => {
      const result = await uploadRequestBodyInParts({
        url: `${ORIGIN}/v1/chat/completions`,
        headers: {},
        compressedBody: randomBytes(REQUEST_BODY_UPLOAD_MIN_BYTES - 1),
        encoding: 'gzip',
        fetchImpl: okFetch,
      });
      expect(result).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('returns null instead of throwing when a part is refused', async () => {
      const compressedBody = randomBytes(REQUEST_BODY_UPLOAD_MIN_BYTES * 2);
      const rejectFetch: BodyUploadFetch = (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        const index = Number(init.headers[REQUEST_BODY_UPLOAD_PART_INDEX_HEADER]);
        return Promise.resolve(index === 0 ? { ok: false, status: 500 } : { ok: true, status: 200 });
      };
      const result = await uploadRequestBodyInParts({
        url: `${ORIGIN}/v1/chat/completions`,
        headers: {},
        compressedBody,
        encoding: 'gzip',
        fetchImpl: rejectFetch,
      });
      expect(result).toBeNull();
      expect(calls.length).toBeGreaterThan(0);
    });

    it('returns null instead of throwing when the transport fails', async () => {
      const compressedBody = randomBytes(REQUEST_BODY_UPLOAD_MIN_BYTES * 2);
      const throwingFetch: BodyUploadFetch = () => Promise.reject(new Error('socket hang up'));
      await expect(uploadRequestBodyInParts({
        url: `${ORIGIN}/v1/chat/completions`,
        headers: {},
        compressedBody,
        encoding: 'gzip',
        fetchImpl: throwingFetch,
      })).resolves.toBeNull();
    });

    it('returns null for a url whose origin cannot be resolved', async () => {
      const result = await uploadRequestBodyInParts({
        url: 'not a url',
        headers: {},
        compressedBody: randomBytes(REQUEST_BODY_UPLOAD_MIN_BYTES * 2),
        encoding: 'gzip',
        fetchImpl: okFetch,
      });
      expect(result).toBeNull();
      expect(calls).toHaveLength(0);
    });
  });
});
