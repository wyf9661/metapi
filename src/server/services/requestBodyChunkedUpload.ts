import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { secretsEqual } from '../middleware/auth.js';
import { authorizeDownstreamToken } from './downstreamApiKeyService.js';
import {
  parseRequestBodyEncoding,
  resolveRequestOrigin,
  type RequestBodyEncoding,
} from './requestBodyCompression.js';

/**
 * Striped (multi-part, parallel) upload of a compressed request body between
 * cascaded metapi instances.
 *
 * Measured on a real hop: a single stream through the Cloudflare tunnel moves
 * ~145 KB/s, while four concurrent streams move ~290 KB/s — the tunnel throttles
 * per stream, not in total. So a body split into N parts and uploaded in
 * parallel halves the time this leg costs, and the receiving side reassembles
 * the parts before its own body parser runs.
 *
 * The negotiation mirrors requestBodyCompression: the receiver advertises
 * `x-metapi-body-upload: chunked` on every response, the sender learns it per
 * origin and only stripes towards origins that asked for it. A peer that
 * advertises nothing keeps receiving one plain request, and any failure on the
 * upload path (bad status, transport error, timeout) makes the sender fall back
 * to that same single request — the fast path must never be able to break a hop.
 */

/** Advertised by the receiving instance, learned by the sending one. */
export const REQUEST_BODY_UPLOAD_CAPABILITY_HEADER = 'x-metapi-body-upload';
export const REQUEST_BODY_UPLOAD_CHUNKED_VALUE = 'chunked';
export const REQUEST_BODY_UPLOAD_ID_HEADER = 'x-metapi-body-upload-id';
export const REQUEST_BODY_UPLOAD_PART_INDEX_HEADER = 'x-metapi-body-upload-part-index';
export const REQUEST_BODY_UPLOAD_PART_COUNT_HEADER = 'x-metapi-body-upload-part-count';
export const REQUEST_BODY_UPLOAD_SHA256_HEADER = 'x-metapi-body-upload-sha256';
export const REQUEST_BODY_UPLOAD_ENCODING_HEADER = 'x-metapi-body-upload-encoding';

/**
 * Minimum compressed body size that is worth splitting. Measured on the real
 * cascade link (US edge -> Cloudflare quick tunnel -> peer) on 2026-10-27 with
 * paired single-stream/parallel runs: at 192-256 KB two streams tie with the
 * single request (median delta -15 ms), at 384 KB splitting LOSES ~210 ms, at
 * 512 KB it wins in 6/6 paired runs (median -411 ms), and at 768 KB two parts
 * are a wash while three parts (~256 KB each) are better. 512 KB therefore puts
 * the threshold on the winning side of the crossover and leaves the losing
 * 384-511 KB band on a single stream.
 */
export const REQUEST_BODY_UPLOAD_MIN_BYTES = 512 * 1024;

/** Four parallel streams already reach the tunnel's aggregate rate. */
export const REQUEST_BODY_UPLOAD_MAX_PARTS = 4;

/** Memory guard for the receiving side: cap on all buffered parts together. */
export const REQUEST_BODY_UPLOAD_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Bound on concurrently pending uploads. The byte cap alone is not enough —
 * a client can open many tiny uploads (one entry object each), so without
 * this any authenticated downstream key could grow the registry without
 * limit. Combined caps: entries × per-part + buffered ≤ bounded.
 */
export const REQUEST_BODY_UPLOAD_MAX_PENDING_UPLOADS = 64;

/**
 * How long a partly uploaded body is kept. The sender waits for every part
 * before it dispatches the request that consumes the upload, so an upload that
 * is still incomplete this long after its first part is debris.
 */
export const REQUEST_BODY_UPLOAD_TTL_MS = 60000;

export const REQUEST_BODY_UPLOAD_ROUTE_PREFIX = '/api/v1/peer/body-upload';

const SWEEP_INTERVAL_MS = 30000;

/** Bounded registry of origins that advertised support (LRU by recency). */
const CAPABILITY_CACHE_MAX_ENTRIES = 512;

const chunkedUploadOrigins = new Set<string>();

/**
 * Learn from an upstream response whether that origin accepts striped uploads.
 * Like the encoding negotiation, a response without the header is not a
 * downgrade signal and leaves the remembered state alone.
 */
export function learnUpstreamBodyUploadCapability(
  origin: string | null,
  response: { headers?: { get?: (name: string) => string | null } | null } | null | undefined,
): void {
  if (!origin) return;
  const raw = response?.headers?.get?.(REQUEST_BODY_UPLOAD_CAPABILITY_HEADER);
  if (typeof raw !== 'string' || raw.length === 0) return;
  const advertised = raw.split(',').map((value) => value.trim().toLowerCase());
  if (!advertised.includes(REQUEST_BODY_UPLOAD_CHUNKED_VALUE)) return;

  if (chunkedUploadOrigins.has(origin)) chunkedUploadOrigins.delete(origin);
  chunkedUploadOrigins.add(origin);
  while (chunkedUploadOrigins.size > CAPABILITY_CACHE_MAX_ENTRIES) {
    const oldest = chunkedUploadOrigins.values().next();
    if (oldest.done) break;
    chunkedUploadOrigins.delete(oldest.value);
  }
}

/** Whether this origin advertised striped uploads (refreshes its recency). */
export function supportsChunkedBodyUpload(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (!chunkedUploadOrigins.has(origin)) return false;
  // Refresh recency: `has` alone does not move a key in Set iteration order.
  chunkedUploadOrigins.delete(origin);
  chunkedUploadOrigins.add(origin);
  return true;
}

/** Whether a body of this size towards this origin should be striped. */
export function shouldStripeRequestBody(input: {
  origin: string | null;
  byteLength: number;
}): boolean {
  if (input.byteLength < REQUEST_BODY_UPLOAD_MIN_BYTES) return false;
  return supportsChunkedBodyUpload(input.origin);
}

/**
 * Upload base for a request URL, or null when the URL cannot be parsed. The
 * striped upload always lives on the same origin as the request it preludes.
 */
export function buildBodyUploadBaseUrl(requestUrl: string): string | null {
  const origin = resolveRequestOrigin(requestUrl);
  if (!origin) return null;
  return `${origin}${REQUEST_BODY_UPLOAD_ROUTE_PREFIX}`;
}

export type BodyUploadFetchInit = {
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
  signal?: AbortSignal;
};

export type BodyUploadFetchResponse = { ok: boolean; status: number };

/**
 * The subset of `fetch` this module needs, so tests can pass a stub and the
 * caller can pass undici's fetch (whose Response is structurally wider).
 */
export type BodyUploadFetch = (
  url: string,
  init: BodyUploadFetchInit,
) => Promise<BodyUploadFetchResponse>;

function resolvePartCount(byteLength: number): number {
  const wanted = Math.ceil(byteLength / REQUEST_BODY_UPLOAD_MIN_BYTES);
  return Math.min(Math.max(wanted, 2), REQUEST_BODY_UPLOAD_MAX_PARTS);
}

/** Even split: no stream carries more than it must, so none is the straggler. */
function sliceBody(body: Buffer, partCount: number): Buffer[] {
  const partSize = Math.ceil(body.length / partCount);
  const parts: Buffer[] = [];
  for (let index = 0; index < partCount; index += 1) {
    parts.push(body.subarray(index * partSize, Math.min((index + 1) * partSize, body.length)));
  }
  return parts;
}

/**
 * Headers for one part: the caller's own headers (auth, routing) minus the ones
 * that describe the body we replaced. A part is raw bytes of the already
 * compressed body, so leaving `content-encoding: gzip` on it would make the
 * receiver try to decode the part itself, and the whole body's length is wrong
 * for a part. The encoding travels in its own header instead.
 *
 * The upload id travels in the URL only. Its header is the placeholder
 * request's signal — the receiver's compression hook keys on exactly that
 * header to reassemble a body — so stamping it on a part makes the receiver
 * try to assemble a body whose parts are still arriving, and it rejects every
 * part with 400 "Uploaded request body is missing or incomplete".
 */
function buildPartHeaders(
  callerHeaders: Record<string, string>,
  meta: { uploadId: string; partCount: number; sha256: string; encoding: RequestBodyEncoding },
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(callerHeaders)) {
    const name = key.toLowerCase();
    if (
      name === 'content-length'
      || name === 'content-encoding'
      || name === 'content-type'
      || name === REQUEST_BODY_UPLOAD_ID_HEADER
    ) {
      continue;
    }
    headers[key] = value;
  }
  headers['content-type'] = 'application/octet-stream';
  headers[REQUEST_BODY_UPLOAD_PART_COUNT_HEADER] = String(meta.partCount);
  headers[REQUEST_BODY_UPLOAD_SHA256_HEADER] = meta.sha256;
  headers[REQUEST_BODY_UPLOAD_ENCODING_HEADER] = meta.encoding;
  return headers;
}

/**
 * Upload a compressed body as parallel parts and return the id the following
 * request must carry. Returns null when the origin has not advertised striped
 * uploads, when the body is too small to be worth it, or when any part failed —
 * the caller then sends the body the ordinary way. This function never throws
 * and never leaves a half-uploaded body behind as a reason to fail a request.
 */
export async function uploadRequestBodyInParts(input: {
  url: string;
  headers: Record<string, string>;
  compressedBody: Buffer;
  encoding: RequestBodyEncoding;
  signal?: AbortSignal;
  fetchImpl?: BodyUploadFetch;
}): Promise<{ uploadId: string } | null> {
  try {
    const { url, headers, compressedBody, encoding, signal } = input;
    if (!supportsChunkedBodyUpload(resolveRequestOrigin(url))) return null;
    if (compressedBody.length < REQUEST_BODY_UPLOAD_MIN_BYTES) return null;

    const baseUrl = buildBodyUploadBaseUrl(url);
    if (!baseUrl) return null;
    const fetchImpl = input.fetchImpl
      ?? (globalThis.fetch as unknown as BodyUploadFetch | undefined);
    if (typeof fetchImpl !== 'function') return null;

    const partCount = resolvePartCount(compressedBody.length);
    const parts = sliceBody(compressedBody, partCount);
    const sha256 = createHash('sha256').update(compressedBody).digest('hex');
    const uploadId = randomBytes(16).toString('hex');
    const partHeaders = buildPartHeaders(headers, { uploadId, partCount, sha256, encoding });

    // Our own abort lets one failed part stop the rest; the caller's signal
    // (the request deadline) still cancels everything.
    const controller = new AbortController();
    const partSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

    const failed = await Promise.all(parts.map(async (part, index) => {
      try {
        const init: BodyUploadFetchInit = {
          method: 'POST',
          headers: { ...partHeaders, [REQUEST_BODY_UPLOAD_PART_INDEX_HEADER]: String(index) },
          body: part,
          signal: partSignal,
        };
        const response = await fetchImpl(`${baseUrl}/${uploadId}/${index}`, init);
        if (response?.ok === true) return false;
      } catch {
        // Transport failure or abort: same verdict as a non-2xx status.
      }
      // The receiver discards an upload that never completes, so pushing the
      // remaining parts would only spend tunnel bandwidth on debris.
      controller.abort();
      return true;
    }));

    if (failed.some((partFailed) => partFailed)) return null;
    return { uploadId };
  } catch {
    return null;
  }
}

type PendingBodyUpload = {
  partCount: number;
  sha256: string;
  encoding: RequestBodyEncoding;
  parts: Map<number, Buffer>;
  bytes: number;
  createdAt: number;
};

const pendingBodyUploads = new Map<string, PendingBodyUpload>();

let bufferedUploadBytes = 0;
let uploadTtlMs = REQUEST_BODY_UPLOAD_TTL_MS;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export type StoreBodyPartResult =
  | { ok: true }
  | { ok: false; statusCode: number; reason: string };

function rejectPart(statusCode: number, reason: string): StoreBodyPartResult {
  return { ok: false, statusCode, reason };
}

function isExpired(entry: PendingBodyUpload, now: number): boolean {
  return now - entry.createdAt > uploadTtlMs;
}

function discardUpload(uploadId: string): void {
  const entry = pendingBodyUploads.get(uploadId);
  if (!entry) return;
  bufferedUploadBytes = Math.max(0, bufferedUploadBytes - entry.bytes);
  pendingBodyUploads.delete(uploadId);
}

/** Expired parts are dropped lazily on access as well; this bounds idle sticks. */
function sweepExpiredUploads(now = Date.now()): void {
  for (const [uploadId, entry] of pendingBodyUploads) {
    if (isExpired(entry, now)) discardUpload(uploadId);
  }
}

/**
 * Started on the first stored part rather than at import: a test process that
 * only reads constants must not be held open by a timer.
 */
function ensureSweepTimer(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpiredUploads, SWEEP_INTERVAL_MS);
  if (typeof (sweepTimer as { unref?: () => void }).unref === 'function') {
    (sweepTimer as { unref: () => void }).unref();
  }
}

/**
 * Receiver side: remember one part of a striped body. Everything is validated
 * here because the route is reachable through the tunnel: an index outside the
 * declared part count, a repeated index, metadata that disagrees with the parts
 * already stored, or more buffered bytes than the cap all refuse the part.
 */
export function storeUploadedBodyPart(input: {
  uploadId: string;
  index: number;
  partCount: number;
  sha256: string;
  encoding: string;
  bytes: Buffer;
}): StoreBodyPartResult {
  const { uploadId, index, partCount, bytes } = input;
  if (typeof uploadId !== 'string' || uploadId.length === 0 || uploadId.length > 128) {
    return rejectPart(400, 'Invalid upload id');
  }
  if (!Number.isInteger(partCount) || partCount < 2 || partCount > REQUEST_BODY_UPLOAD_MAX_PARTS) {
    return rejectPart(400, 'Invalid part count');
  }
  if (!Number.isInteger(index) || index < 0 || index >= partCount) {
    return rejectPart(400, 'Part index out of range');
  }
  if (typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)) {
    return rejectPart(400, 'Invalid body digest');
  }
  const encoding = parseRequestBodyEncoding(input.encoding);
  if (!encoding) return rejectPart(400, 'Unsupported body encoding');

  const now = Date.now();
  const existing = pendingBodyUploads.get(uploadId);
  if (existing && isExpired(existing, now)) discardUpload(uploadId);

  const entry = pendingBodyUploads.get(uploadId);
  if (!entry) {
    if (bytes.length > REQUEST_BODY_UPLOAD_MAX_TOTAL_BYTES) {
      return rejectPart(413, 'Uploaded body exceeds the accepted size');
    }
    // The global byte cap must also gate upload creation: otherwise every new
    // uploadId starts a fresh 32MB budget and the "global" guard never fires.
    if (bufferedUploadBytes + bytes.length > REQUEST_BODY_UPLOAD_MAX_TOTAL_BYTES) {
      return rejectPart(413, 'Uploaded body exceeds the accepted size');
    }
    if (pendingBodyUploads.size >= REQUEST_BODY_UPLOAD_MAX_PENDING_UPLOADS) {
      return rejectPart(429, 'Too many pending uploads');
    }
    ensureSweepTimer();
    pendingBodyUploads.set(uploadId, {
      partCount,
      sha256: input.sha256,
      encoding,
      parts: new Map([[index, bytes]]),
      bytes: bytes.length,
      createdAt: now,
    });
    bufferedUploadBytes += bytes.length;
    return { ok: true };
  }

  if (
    entry.partCount !== partCount
    || entry.sha256 !== input.sha256
    || entry.encoding !== encoding
  ) {
    return rejectPart(409, 'Part does not match the pending upload');
  }
  if (entry.parts.has(index)) return rejectPart(409, 'Duplicate part index');
  if (bufferedUploadBytes + bytes.length > REQUEST_BODY_UPLOAD_MAX_TOTAL_BYTES) {
    return rejectPart(413, 'Uploaded body exceeds the accepted size');
  }

  entry.parts.set(index, bytes);
  entry.bytes += bytes.length;
  bufferedUploadBytes += bytes.length;
  return { ok: true };
}

/**
 * Receiver side: join the parts of an upload into the original compressed body,
 * or null when the upload is unknown, expired, incomplete, or does not hash to
 * what the sender declared. The upload is consumed either way: the parts must
 * not be reusable for a second request.
 *
 * The sender awaits every part response before it dispatches the request that
 * carries the id, so a missing part means the upload failed — start over rather
 * than hold the remaining bytes.
 */
export function assembleUploadedBody(
  uploadId: string,
): { compressed: Buffer; encoding: RequestBodyEncoding } | null {
  const entry = pendingBodyUploads.get(uploadId);
  if (!entry) return null;
  if (isExpired(entry, Date.now())) {
    discardUpload(uploadId);
    return null;
  }
  const parts: Buffer[] = [];
  for (let index = 0; index < entry.partCount; index += 1) {
    const part = entry.parts.get(index);
    if (!part) {
      discardUpload(uploadId);
      return null;
    }
    parts.push(part);
  }
  const compressed = Buffer.concat(parts);
  discardUpload(uploadId);
  if (createHash('sha256').update(compressed).digest('hex') !== entry.sha256) return null;
  return { compressed, encoding: entry.encoding };
}

/**
 * Credential carried by one upload part: the caller's own Authorization
 * (Bearer), x-api-key, or x-goog-api-key header — the header surface the proxy
 * accepts for /v1. (The proxy also takes a `?key=` query parameter, which
 * cannot arrive here: the upload URL the sender builds carries no query.)
 * Parts are copied from the headers of the request they prelude, so a cascaded
 * sender presents that request's DOWNSTREAM key, not the admin token.
 */
function extractUploadToken(request: { headers: Record<string, unknown> }): string | null {
  const auth = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  for (const name of ['x-api-key', 'x-goog-api-key']) {
    const value = request.headers[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Two accepted credentials, checked in that order:
 *
 * 1. the admin token — the peer-endpoint credential, kept working so a trusted
 *    peer (or a hand-run curl) that already holds it is unaffected;
 * 2. otherwise the request's own downstream key, validated by the very service
 *    the /v1 proxy uses (authorizeDownstreamToken), so the key's lifecycle rules
 *    (enabled, expiry, budgets) are the same ones that gate the request these
 *    parts belong to.
 *
 * proxyAuthMiddleware is deliberately NOT used here: it bills a full proxy
 * request per stored part (request quota, RPM window, in-flight slot), so one
 * striped body would count 2-4 extra requests and could consume the key's last
 * request allowance before the real request even arrives, turning a fast path
 * into a 403 on the request it was supposed to accelerate. Validation without
 * accounting is what a transport fragment needs.
 */
async function authorizeUploadPart(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const token = extractUploadToken(request) || '';
  if (token && secretsEqual(token, config.authToken)) return;

  if (token) {
    const authResult = await authorizeDownstreamToken(token);
    if (authResult.ok) return;
  }

  // Same bare 401 as the other peer endpoints, for the same reason: one shape
  // and no marker to probe for, whether the credential was absent or wrong.
  return reply.code(401).send({ error: 'Invalid token' });
}

function readUploadHeader(request: { headers: Record<string, unknown> }, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string' && value.length > 0) return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
    return value[0].trim();
  }
  return null;
}

/** A decimal integer in canonical form, or null for anything else. */
function parseCanonicalInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[0-9]{1,6}$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return String(parsed) === value ? parsed : null;
}

async function handleUploadBodyPart(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  // Authentication happens in this plugin's onRequest hook (see
  // authorizeUploadPart): the admin token or the request's own downstream key.
  const params = (request.params ?? {}) as { uploadId?: unknown; index?: unknown };
  const uploadId = typeof params.uploadId === 'string' ? params.uploadId : '';
  const headerUploadId = readUploadHeader(request, REQUEST_BODY_UPLOAD_ID_HEADER);
  // The URL is authoritative; a header that names a different upload means the
  // sender mixed two uploads up, so refuse instead of guessing.
  if (!uploadId || (headerUploadId !== null && headerUploadId !== uploadId)) {
    return reply.code(400).send({ error: 'Invalid upload id' });
  }

  const index = parseCanonicalInteger(params.index);
  const headerIndex = parseCanonicalInteger(readUploadHeader(request, REQUEST_BODY_UPLOAD_PART_INDEX_HEADER));
  if (index === null || headerIndex === null || headerIndex !== index) {
    return reply.code(400).send({ error: 'Invalid part index' });
  }

  const partCount = parseCanonicalInteger(readUploadHeader(request, REQUEST_BODY_UPLOAD_PART_COUNT_HEADER));
  if (partCount === null) {
    return reply.code(400).send({ error: 'Invalid part count' });
  }

  const result = storeUploadedBodyPart({
    uploadId,
    index,
    partCount,
    sha256: (readUploadHeader(request, REQUEST_BODY_UPLOAD_SHA256_HEADER) || '').toLowerCase(),
    encoding: readUploadHeader(request, REQUEST_BODY_UPLOAD_ENCODING_HEADER) || '',
    bytes: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
  });
  if (!result.ok) {
    return reply.code(result.statusCode).send({ error: result.reason });
  }
  return reply.send({ ok: true });
}

/**
 * Receiver side: accept striped bodies and advertise the capability. The route,
 * its authentication and its media type parser are registered in their own
 * plugin scope so no other route changes behaviour — outside this scope an
 * undeclared media type still gets its 415 and no /v1 route sees the extra
 * onRequest hook.
 *
 * NOTE for the server wiring: this prefix also sits behind the global `/api/`
 * admin gate in src/server/index.ts (`request.url.startsWith('/api/') &&
 * !isPublicApiRoute(...)` → authMiddleware). That gate is admin-token-only, so
 * on its own it refuses a part that carries just the downstream key (verified:
 * 403 'Invalid token', parts then fall back to the single request). For the
 * striped path to work end to end the prefix must be exempted there — or added
 * to isPublicApiRoute — since the checks below already authenticate it.
 */
export function registerChunkedBodyUploadRoutes(app: FastifyInstance): void {
  const target = app as FastifyInstance & { __metapiChunkedBodyUploadRegistered?: boolean };
  if (target.__metapiChunkedBodyUploadRegistered) return;

  app.addHook('onSend', async (_request, reply, payload) => {
    // Fastify runs onSend hooks LIFO, so a plugin registered later (e.g.
    // @fastify/compress) can already have committed the response. Setting a
    // header then throws ERR_HTTP_HEADERS_SENT, which only produces log noise:
    // skip it instead of failing the response.
    if (reply.raw?.headersSent) return payload;
    reply.header(REQUEST_BODY_UPLOAD_CAPABILITY_HEADER, REQUEST_BODY_UPLOAD_CHUNKED_VALUE);
    return payload;
  });

  app.register(async (scope) => {
    // Parts are sent with the headers of the request being uploaded, so the
    // credential here is that request's downstream key — or the admin token.
    scope.addHook('onRequest', authorizeUploadPart);

    // Parts are opaque compressed bytes, not JSON, and each one carries up to a
    // share of the whole-body cap — hence the parser's own bodyLimit.
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: REQUEST_BODY_UPLOAD_MAX_TOTAL_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );
    scope.post(`${REQUEST_BODY_UPLOAD_ROUTE_PREFIX}/:uploadId/:index`, handleUploadBodyPart);
  });

  target.__metapiChunkedBodyUploadRegistered = true;
}

/** Test helpers. */
export function __resetChunkedBodyUploadForTests(): void {
  pendingBodyUploads.clear();
  bufferedUploadBytes = 0;
  uploadTtlMs = REQUEST_BODY_UPLOAD_TTL_MS;
  chunkedUploadOrigins.clear();
}

export function __setChunkedBodyUploadTtlForTests(ms: number): void {
  uploadTtlMs = ms;
}

export function __getChunkedBodyUploadStatsForTests(): {
  pendingUploads: number;
  bufferedBytes: number;
} {
  return { pendingUploads: pendingBodyUploads.size, bufferedBytes: bufferedUploadBytes };
}
