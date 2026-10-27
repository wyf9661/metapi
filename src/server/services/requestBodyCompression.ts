import {
  constants as zlibConstants,
  gunzip as gunzipCallback,
  gzip as gzipCallback,
  zstdCompress as zstdCompressCallback,
  zstdDecompress as zstdDecompressCallback,
} from 'node:zlib';
import { Readable, type Readable as ReadableStream } from 'node:stream';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import {
  REQUEST_BODY_UPLOAD_ID_HEADER,
  REQUEST_BODY_UPLOAD_ROUTE_PREFIX,
  assembleUploadedBody,
} from './requestBodyChunkedUpload.js';

/**
 * Compressed request bodies for cascaded metapi instances.
 *
 * A cascade hop re-uploads the whole prompt (hundreds of KB on agent traffic)
 * through a Cloudflare tunnel, which is the dominant part of the extra latency
 * the cascade adds — and the same bytes cross that tunnel twice (once to the
 * edge, once from the edge to the peer's connector), so every byte saved is
 * saved at two different rates.
 *
 * Both ends of such a hop are metapi, so the body can travel compressed: the
 * receiving instance advertises which encodings it can decode on every response
 * (`x-metapi-body-encoding: zstd, gzip`), and the sending instance compresses
 * towards that origin with the strongest encoding both sides support (zstd
 * ahead of gzip). An unpatched peer advertises nothing, so it keeps receiving
 * plain JSON — the negotiation makes this safe to roll out one side at a time,
 * and a peer that only knows gzip keeps getting gzip.
 */

/** Advertised by the receiving instance, learned by the sending one. */
export const REQUEST_BODY_ENCODING_CAPABILITY_HEADER = 'x-metapi-body-encoding';
export const REQUEST_BODY_GZIP_ENCODING = 'gzip';
export const REQUEST_BODY_ZSTD_ENCODING = 'zstd';

export type RequestBodyEncoding =
  | typeof REQUEST_BODY_GZIP_ENCODING
  | typeof REQUEST_BODY_ZSTD_ENCODING;

/** Strongest first: the sender walks this list and takes the first match. */
const SENDER_PREFERENCE: readonly RequestBodyEncoding[] = [
  REQUEST_BODY_ZSTD_ENCODING,
  REQUEST_BODY_GZIP_ENCODING,
];

/**
 * zstd level 12. Measured on a real 1.03 MB agent payload: level 12 reaches
 * 4.57x in ~18 ms, level 19 reaches 5.02x in ~180 ms, gzip -9 reaches 4.12x in
 * ~26 ms. The extra 160 ms of CPU at level 19 buys ~0.05 s on the wire, so 12
 * is the knee. Compression runs in the libuv threadpool, so this is throughput
 * budget, not event-loop blocking.
 */
export const REQUEST_BODY_ZSTD_COMPRESSION_LEVEL = 12;

/** Below this size the CPU + header overhead is not worth it. */
export const REQUEST_BODY_COMPRESSION_MIN_BYTES = 4096;

/** Zip-bomb guard: hard cap on the decompressed size of an inbound body. */
export const MAX_DECOMPRESSED_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Memory guard for the receiving side: the largest compressed body we buffer
 * before decoding. Decompression happens in the `preParsing` hook, so the input
 * must be materialized first; this cap keeps an unauthenticated peer from making
 * us buffer unbounded data. Legitimate cascade bodies are a few MB at most.
 */
export const MAX_COMPRESSED_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/** Bounded registry of origins that advertised support (LRU by recency). */
const CAPABILITY_CACHE_MAX_ENTRIES = 512;

const gzipAsync = promisify(gzipCallback);
const zstdCompressAsync = promisify(zstdCompressCallback);
const gunzipAsync = promisify(gunzipCallback);
const zstdDecompressAsync = promisify(zstdDecompressCallback);

/**
 * gzip always exists in `node:zlib`; zstd landed in Node 22.15 / 23.8 and this
 * repo requires Node >= 24, but the guard keeps the module inert (gzip-only)
 * rather than crashing if it is ever loaded on an older runtime.
 */
const ZSTD_CODEC_AVAILABLE =
  typeof zstdCompressCallback === 'function' && typeof zstdDecompressCallback === 'function';

/** Encodings this process can advertise for inbound request bodies. */
export function advertisedRequestBodyEncodings(): RequestBodyEncoding[] {
  return SENDER_PREFERENCE.filter(
    (encoding) => encoding !== REQUEST_BODY_ZSTD_ENCODING || ZSTD_CODEC_AVAILABLE,
  );
}

/** Best encoding this origin advertised, remembered for the next request. */
const supportedOrigins = new Map<string, RequestBodyEncoding>();

let maxDecompressedRequestBodyBytes = MAX_DECOMPRESSED_REQUEST_BODY_BYTES;
let maxCompressedRequestBodyBytes = MAX_COMPRESSED_REQUEST_BODY_BYTES;

export type UpstreamRequestBody = {
  headers: Record<string, string>;
  body: string | Buffer;
  compressed: boolean;
};

function findHeaderName(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === wanted);
}

/** Origin (scheme://host[:port]) of an upstream URL, or null when unparseable. */
export function resolveRequestOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Learn from an upstream response which encoding that origin accepts. Called
 * for every response (success and failure alike) so a single real request is
 * enough to enable compression for that origin.
 *
 * A response without the header is not a downgrade signal (unpatched peer,
 * unrelated response) and leaves the remembered value alone; a response that
 * advertises only gzip after zstd does downgrade us, which is what keeps a
 * peer rollback safe.
 */
export function learnUpstreamRequestBodyEncoding(
  origin: string | null,
  response: { headers?: { get?: (name: string) => string | null } | null } | null | undefined,
): void {
  if (!origin) return;
  const raw = response?.headers?.get?.(REQUEST_BODY_ENCODING_CAPABILITY_HEADER);
  if (typeof raw !== 'string' || raw.length === 0) return;
  const advertised = raw.split(',').map((value) => value.trim().toLowerCase());
  const best = advertisedRequestBodyEncodings().find((encoding) => advertised.includes(encoding));
  if (!best) return;

  if (supportedOrigins.has(origin)) supportedOrigins.delete(origin);
  supportedOrigins.set(origin, best);
  while (supportedOrigins.size > CAPABILITY_CACHE_MAX_ENTRIES) {
    const oldest = supportedOrigins.keys().next();
    if (oldest.done) break;
    supportedOrigins.delete(oldest.value);
  }
}

/** Encoding to use for this origin, refreshing its recency, or null. */
export function resolveUpstreamRequestBodyEncoding(
  origin: string | null | undefined,
): RequestBodyEncoding | null {
  if (!origin) return null;
  const encoding = supportedOrigins.get(origin);
  if (!encoding) return null;
  // Refresh recency: `get` alone does not move a key in Map iteration order.
  supportedOrigins.delete(origin);
  supportedOrigins.set(origin, encoding);
  return encoding;
}

export function supportsCompressedRequestBody(origin: string | null | undefined): boolean {
  return resolveUpstreamRequestBodyEncoding(origin) !== null;
}

/**
 * Normalize undici's several header shapes (Headers | Map | string[][] | record)
 * to a plain record. Returns null when the shape is not recognized — callers
 * must then leave the request alone rather than rebuild its headers.
 *
 * Duck-typing, NOT `instanceof Headers`: the npm `undici` package ships its own
 * `Headers` class, so `new (require('undici').Headers)() instanceof
 * globalThis.Headers` is false. Snapshotting such an instance with a spread
 * yields `{}` and silently drops Authorization — which the receiving instance
 * answers with `401 Missing Authorization`.
 */
export function toPlainHeaderRecord(headers: unknown): Record<string, string> | null {
  if (!headers) return {};
  const candidate = headers as {
    forEach?: (cb: (value: unknown, key: unknown) => void) => void;
    entries?: () => Iterable<[unknown, unknown]>;
    get?: (key: unknown) => unknown;
  };
  if (headers instanceof Map) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[String(key)] = String(value);
    return out;
  }
  // Arrays must be checked before the generic `entries()` branch: an array also
  // has `.entries()`, but it yields [index, value] and would mangle the pairs.
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const entry of headers as [string, string][]) {
      if (Array.isArray(entry) && entry.length >= 2) out[String(entry[0])] = String(entry[1]);
    }
    return out;
  }
  if (typeof candidate.forEach === 'function' && typeof candidate.get === 'function') {
    const out: Record<string, string> = {};
    candidate.forEach((value, key) => {
      out[String(key)] = String(value);
    });
    return out;
  }
  if (typeof candidate.entries === 'function') {
    const out: Record<string, string> = {};
    for (const entry of candidate.entries()) {
      if (Array.isArray(entry) && entry.length >= 2) out[String(entry[0])] = String(entry[1]);
    }
    return out;
  }
  if (typeof headers === 'object' && Object.getPrototypeOf(headers) === Object.prototype) {
    return { ...(headers as Record<string, string>) };
  }
  return null;
}

/**
 * Compress an upstream request body when the origin is known to accept it, with
 * the strongest encoding both ends support. Returns the input untouched (same
 * header object, string body) otherwise.
 */
export async function maybeCompressUpstreamRequestBody(input: {
  origin: string | null;
  headers: Record<string, string>;
  bodyText: string;
}): Promise<UpstreamRequestBody> {
  const { origin, headers, bodyText } = input;
  const unchanged: UpstreamRequestBody = { headers, body: bodyText, compressed: false };
  const learned = resolveUpstreamRequestBodyEncoding(origin);
  if (!learned) return unchanged;
  if (Buffer.byteLength(bodyText) < REQUEST_BODY_COMPRESSION_MIN_BYTES) return unchanged;
  if (findHeaderName(headers, 'content-encoding')) return unchanged;

  const source = Buffer.from(bodyText);
  let encoding: RequestBodyEncoding = learned;
  let body: Buffer;
  if (learned === REQUEST_BODY_ZSTD_ENCODING && ZSTD_CODEC_AVAILABLE) {
    body = await zstdCompressAsync(source, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: REQUEST_BODY_ZSTD_COMPRESSION_LEVEL },
    });
  } else {
    encoding = REQUEST_BODY_GZIP_ENCODING;
    body = await gzipAsync(source);
  }

  const nextHeaders: Record<string, string> = { ...headers };
  const contentLength = findHeaderName(nextHeaders, 'content-length');
  if (contentLength) delete nextHeaders[contentLength];
  const contentEncoding = findHeaderName(nextHeaders, 'content-encoding');
  if (contentEncoding) delete nextHeaders[contentEncoding];
  nextHeaders['content-encoding'] = encoding;
  return { headers: nextHeaders, body, compressed: true };
}

function toStatusError(message: string, statusCode: number, code: string): Error {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

/** Decode a `Content-Encoding` request header into a supported encoding. */
export function parseRequestBodyEncoding(value: unknown): RequestBodyEncoding | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const tokens = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((token) => token.length > 0 && token !== 'identity');
  // The cascade hop always sends exactly one coding. A chain (`gzip, zstd`) is
  // applied in order and would have to be decoded in reverse — decoding only the
  // outer layer would hand the parser garbage, so leave the chain to the parser
  // (which answers 400) instead of half-decoding it.
  if (tokens.length !== 1) return null;
  const [token] = tokens;
  if (token === REQUEST_BODY_ZSTD_ENCODING && ZSTD_CODEC_AVAILABLE) {
    return REQUEST_BODY_ZSTD_ENCODING;
  }
  if (token === REQUEST_BODY_GZIP_ENCODING || token === 'x-gzip') {
    return REQUEST_BODY_GZIP_ENCODING;
  }
  return null;
}

/**
 * Read a request payload into memory, refusing to buffer more than the cap.
 * `for await` also surfaces client aborts and stream failures here, so they stay
 * inside the hook instead of escaping as an unhandled 'error' event.
 */
async function readRequestBodyBuffer(
  payload: ReadableStream,
  limitBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of payload) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > limitBytes) {
      payload.destroy();
      throw toStatusError(
        'Compressed request body exceeds the accepted size',
        413,
        'FST_ERR_CTP_BODY_TOO_LARGE',
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Decode a buffered compressed body, capping the decompressed size. Failures are
 * reported as hook rejections, which Fastify answers with 400/413.
 *
 * This replaced a streaming implementation that piped a decoder into the parser
 * and destroyed the returned stream on failure. That version crashed the process
 * with an unhandled 'error' whenever the decode failed before the parser had
 * attached its listeners — reachable unauthenticated through the tunnel with a
 * malformed `Content-Encoding: gzip` body, i.e. a remote DoS.
 */
export async function decodeRequestBodyBuffer(
  encoding: RequestBodyEncoding,
  compressed: Buffer,
): Promise<Buffer> {
  const options = { maxOutputLength: maxDecompressedRequestBodyBytes };
  try {
    return encoding === REQUEST_BODY_ZSTD_ENCODING
      ? await zstdDecompressAsync(compressed, options)
      : await gunzipAsync(compressed, options);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw toStatusError(
        'Compressed request body exceeds the decompression limit',
        413,
        'FST_ERR_CTP_BODY_TOO_LARGE',
      );
    }
    throw toStatusError(
      `Failed to decompress ${encoding} request body: ${
        error instanceof Error ? error.message : String(error)
      }`,
      400,
      'FST_ERR_CTP_INVALID_MEDIA_TYPE',
    );
  }
}

/**
 * Receiver side: decode `Content-Encoding: zstd|gzip` request bodies and
 * advertise the capability. Inert for every request that does not declare the
 * header, so existing clients see byte-identical behaviour.
 */
export function registerCompressedRequestBodySupport(app: FastifyInstance): void {
  const target = app as FastifyInstance & { __metapiRequestBodyCompressionRegistered?: boolean };
  if (target.__metapiRequestBodyCompressionRegistered) return;

  app.addHook('onSend', async (_request, reply, payload) => {
    // Fastify runs onSend hooks LIFO, so a plugin registered later (e.g.
    // @fastify/compress) can already have committed the response. Setting a
    // header then throws ERR_HTTP_HEADERS_SENT, which only produces log noise:
    // skip it instead of failing the response.
    if (reply.raw?.headersSent) return payload;
    reply.header(
      REQUEST_BODY_ENCODING_CAPABILITY_HEADER,
      advertisedRequestBodyEncodings().join(', '),
    );
    return payload;
  });

  app.addHook('preParsing', async (request, _reply, payload) => {
    // Parts of a striped upload are transport fragments, not placeholders: the
    // route stores the raw bytes as they arrive. Leave them untouched — a
    // sender that stamps the upload id on its parts would otherwise have every
    // part rejected here while the body is still being uploaded.
    if (request.url.startsWith(REQUEST_BODY_UPLOAD_ROUTE_PREFIX)) return payload;

    // Striped upload: the sender moved the (already compressed) body out of the
    // request itself and uploaded it as parallel parts, leaving only the id
    // behind. Reassemble it here and decode it exactly like the single-request
    // path below. This branch deliberately ignores content-encoding: under the
    // part path that header is absent (the encoding travels beside the parts),
    // so the only signal is the upload id.
    const rawUploadId = request.headers[REQUEST_BODY_UPLOAD_ID_HEADER];
    const uploadId = Array.isArray(rawUploadId) ? rawUploadId[0] : rawUploadId;
    if (typeof uploadId === 'string' && uploadId.length > 0) {
      const assembled = assembleUploadedBody(uploadId);
      // Unknown, expired, incomplete or digest-mismatched: the placeholder
      // request carries no usable body, so refuse it like any other bad payload.
      if (!assembled) {
        throw toStatusError(
          'Uploaded request body is missing or incomplete',
          400,
          'FST_ERR_CTP_INVALID_MEDIA_TYPE',
        );
      }
      // The placeholder headers describe an empty body with no encoding, so they
      // must not reach the parser as-is.
      delete request.headers[REQUEST_BODY_UPLOAD_ID_HEADER];
      delete request.headers['content-length'];
      const decoded = await decodeRequestBodyBuffer(assembled.encoding, assembled.compressed);
      return Readable.from([decoded]);
    }

    const encoding = parseRequestBodyEncoding(request.headers['content-encoding']);
    if (!encoding || !payload) return payload;

    // The decoded body is what the content type parsers must see, and its length
    // differs from the compressed one.
    delete request.headers['content-encoding'];
    delete request.headers['content-length'];

    const compressed = await readRequestBodyBuffer(
      payload as ReadableStream,
      maxCompressedRequestBodyBytes,
    );
    const decoded = await decodeRequestBodyBuffer(encoding, compressed);
    return Readable.from([decoded]);
  });

  target.__metapiRequestBodyCompressionRegistered = true;
}

/** Test helpers. */
export function __resetRequestBodyCompressionForTests(): void {
  supportedOrigins.clear();
  maxDecompressedRequestBodyBytes = MAX_DECOMPRESSED_REQUEST_BODY_BYTES;
  maxCompressedRequestBodyBytes = MAX_COMPRESSED_REQUEST_BODY_BYTES;
}

export function __setMaxDecompressedRequestBodyBytesForTests(bytes: number): void {
  maxDecompressedRequestBodyBytes = bytes;
}

export function __setMaxCompressedRequestBodyBytesForTests(bytes: number): void {
  maxCompressedRequestBodyBytes = bytes;
}

export function __getRequestBodyCompressionStatsForTests(): {
  trackedOrigins: number;
  zstdAvailable: boolean;
} {
  return { trackedOrigins: supportedOrigins.size, zstdAvailable: ZSTD_CODEC_AVAILABLE };
}
