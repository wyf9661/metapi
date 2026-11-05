import {
  brotliDecompress,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
  gunzip,
  inflate,
  zstdDecompress,
} from 'node:zlib';
import { promisify } from 'node:util';
import {
  learnUpstreamRequestBodyEncoding,
  maybeCompressUpstreamRequestBody,
  resolveRequestOrigin,
  toPlainHeaderRecord,
  type RequestBodyEncoding,
} from '../../services/requestBodyCompression.js';
import {
  REQUEST_BODY_UPLOAD_ID_HEADER,
  learnUpstreamBodyUploadCapability,
  shouldStripeRequestBody,
  uploadRequestBodyInParts,
} from '../../services/requestBodyChunkedUpload.js';
import {
  REQUEST_BODY_DELTA_CAPABILITY_HEADER,
  REQUEST_BODY_STORE_HEADER,
  buildDeltaRequestBody,
  forgetUpstreamRequestBodyDeltaCapability,
  learnUpstreamRequestBodyDeltaCapability,
  rememberSentRequestBody,
  supportsRequestBodyDelta,
} from '../../services/requestBodyDelta.js';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  Response,
  fetch,
  Headers,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from 'undici';

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);
const zstdDecompressAsync = promisify(zstdDecompress);

export type ProxyRuntimeRequest = {
  endpoint: 'chat' | 'messages' | 'responses';
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  runtime?: {
    executor: 'default' | 'codex' | 'gemini-native' | 'gemini-cli' | 'antigravity' | 'claude';
    modelName?: string;
    stream?: boolean;
    oauthProjectId?: string | null;
    action?: 'generateContent' | 'streamGenerateContent' | 'countTokens';
  };
};

export type RuntimeDispatchInput = {
  siteUrl: string;
  request: ProxyRuntimeRequest;
  targetUrl?: string;
  signal?: AbortSignal;
  buildInit: (requestUrl: string, request: ProxyRuntimeRequest) => Promise<UndiciRequestInit> | UndiciRequestInit;
};

export type RuntimeResponse = UndiciResponse;

export type RuntimeExecutor = {
  dispatch(input: RuntimeDispatchInput): Promise<RuntimeResponse>;
};

export function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function withRequestBody(
  request: ProxyRuntimeRequest,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): ProxyRuntimeRequest {
  return {
    ...request,
    headers: headers ? { ...headers } : { ...request.headers },
    body,
  };
}

function buildUpstreamUrl(siteUrl: string, path: string): string {
  const normalizedBase = siteUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

/**
 * Transport failures undici collapses into one opaque message; the actionable
 * reason lives in `error.cause` (Node error code, undici `UND_ERR_*`, host).
 */
const TRANSPORT_FAILURE_MESSAGES = new Set(['fetch failed', 'terminated']);

function describeErrorCause(cause: unknown, depth = 0): string[] {
  if (!cause || typeof cause !== 'object' || depth > 3) return [];
  const record = cause as {
    code?: unknown;
    message?: unknown;
    address?: unknown;
    port?: unknown;
    hostname?: unknown;
    errors?: unknown;
    cause?: unknown;
  };
  const parts: string[] = [];
  const code = typeof record.code === 'string' ? record.code.trim() : '';
  const address = typeof record.address === 'string' ? record.address.trim() : '';
  const port = typeof record.port === 'number' || typeof record.port === 'string' ? String(record.port).trim() : '';
  const hostname = typeof record.hostname === 'string' ? record.hostname.trim() : '';
  // A wrapper (AggregateError, `cause` chain) usually carries a generic message
  // ("all addresses failed") while the useful codes live one level down — prefer
  // the descent over the wrapper's own prose.
  const hasNested = Array.isArray(record.errors) || Boolean(record.cause && record.cause !== cause);
  if (code) {
    const target = address ? `${address}${port ? `:${port}` : ''}` : hostname;
    parts.push(target ? `${code} ${target}` : code);
  } else if (!hasNested && typeof record.message === 'string' && record.message.trim()) {
    parts.push(record.message.trim().slice(0, 120));
  }
  if (Array.isArray(record.errors)) {
    // AggregateError: one entry per resolved address (IPv4 + IPv6).
    for (const nested of record.errors.slice(0, 3)) parts.push(...describeErrorCause(nested, depth + 1));
  } else if (record.cause && record.cause !== cause) {
    parts.push(...describeErrorCause(record.cause, depth + 1));
  }
  return parts;
}

/**
 * Fold undici's hidden cause into the message so proxy logs, the failure
 * taxonomy and the operator all see WHY the connection failed
 * (`fetch failed (ENOTFOUND api.example.com)`), instead of a bare
 * `fetch failed` that is indistinguishable from a TLS mismatch or a reset.
 *
 * The original token stays the prefix so existing /fetch failed/ matchers keep
 * working. The error object itself is preserved — name, `cause` and identity are
 * untouched (abort detection depends on them); only the message gains detail.
 */
export function enrichTransportFailure<T>(error: T): T {
  if (!(error instanceof Error)) return error;
  if (!TRANSPORT_FAILURE_MESSAGES.has(error.message.trim().toLowerCase())) return error;
  const details = Array.from(new Set(describeErrorCause((error as { cause?: unknown }).cause).filter(Boolean)));
  if (details.length === 0) return error;
  try {
    error.message = `${error.message} (${details.join('; ')})`;
  } catch {
    // A frozen error keeps its generic message; the log stays coarser but intact.
  }
  return error;
}

/**
 * A keep-alive socket the peer already closed: the next request that reuses it
 * fails before any response exists. Go's net/http retries this transparently for
 * relay clients (new-api), which is why the same upstreams show no such errors
 * in their logs, while undici surfaces it as `fetch failed` / `terminated`.
 */
const STALE_CONNECTION_FAILURE_PATTERN =
  /econnreset|epipe|econnaborted|und_err_socket|socket hang up|other side closed|\bterminated\b/i;

function isStaleConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // An abort is our own deadline firing, not the peer dropping a socket.
  if (error.name === 'AbortError') return false;
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const causeMessage = typeof cause?.message === 'string' ? cause.message : '';
  return STALE_CONNECTION_FAILURE_PATTERN.test(`${error.message} ${code} ${causeMessage}`);
}

/**
 * Whether a request body can be sent a second time. Streams (and anything else
 * single-shot) must never be replayed: the first attempt may already have
 * consumed part of them.
 */
function isReplayableBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === 'string') return true;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return true;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
  return false;
}

/**
 * A delta request can fail in two recoverable ways: the base expired (409 with
 * the miss marker) or the peer no longer speaks the protocol at all (a 400 with
 * no delta header — an unpatched/rolled-back instance parses the suffix as JSON
 * and rejects it). Both are answered by resending the body whole.
 */
export function isDeltaMissOrDowngrade(response: RuntimeResponse): boolean {
  const advertised = response.headers.get(REQUEST_BODY_DELTA_CAPABILITY_HEADER);
  if (response.status === 409) return advertised === 'miss';
  return response.status === 400 && advertised === null;
}

export async function performFetch(
  input: RuntimeDispatchInput,
  request: ProxyRuntimeRequest,
  requestUrl = input.targetUrl || buildUpstreamUrl(input.siteUrl, request.path),
  options: { disableTransportRetry?: boolean } = {},
): Promise<RuntimeResponse> {
  const init = await input.buildInit(requestUrl, request);
  // Cascade hops re-upload the whole prompt through a tunnel. When the upstream
  // advertised `x-metapi-body-encoding: gzip`, send the body gzipped instead.
  // This is the single fetch point shared by every runtime executor, so wiring
  // it here covers chat/responses/messages alike (the default-fetch branch of
  // endpointFlow is only used by flows that do NOT pass a dispatch hook).
  const origin = resolveRequestOrigin(requestUrl);
  const combinedSignal = input.signal && init.signal
    ? AbortSignal.any([input.signal, init.signal as AbortSignal])
    : (input.signal ?? init.signal);
  let dispatchInit: UndiciRequestInit = init;
  let usedDelta = false;
  // True when this request makes the peer hold the full body (a stored full
  // body, or a delta whose base is already there). Only then may the next turn
  // reference it.
  let bodyStoredOnPeer = false;
  const fullBodyText = typeof init.body === 'string' ? init.body : null;
  const headerRecord = fullBodyText === null ? null : toPlainHeaderRecord(init.headers);

  if (headerRecord && fullBodyText !== null && fullBodyText.length > 0) {
    const delta = buildDeltaRequestBody({ origin, headers: headerRecord, bodyText: fullBodyText });
    const deltaCapable = supportsRequestBodyDelta(origin);
    const bodyText = delta ? delta.bodyText : fullBodyText;
    // A full body towards a delta-capable peer is kept there for next turn.
    const headers: Record<string, string> = {
      ...headerRecord,
      ...(delta
        ? delta.headers
        : (deltaCapable ? { [REQUEST_BODY_STORE_HEADER]: '1' } : {})),
    };
    usedDelta = delta !== null;
    bodyStoredOnPeer = delta !== null || deltaCapable;
    const encoded = await maybeCompressUpstreamRequestBody({ origin, headers, bodyText });
    if (encoded.compressed) {
      dispatchInit = { ...init, headers: encoded.headers, body: encoded.body };
      // A big enough body towards an origin that advertised striped uploads is
      // uploaded as parallel parts first; the request itself then carries only
      // the upload id. `uploadRequestBodyInParts` returns null on any failure
      // (bad status, transport error, abort) and never throws, so a failed
      // upload silently leaves the single compressed request above in place.
      const compressedBody = Buffer.isBuffer(encoded.body)
        ? encoded.body
        : Buffer.from(bodyText);
      const contentEncoding = encoded.headers['content-encoding'];
      if (
        !usedDelta
        && typeof contentEncoding === 'string'
        && contentEncoding.length > 0
        && shouldStripeRequestBody({ origin, byteLength: compressedBody.length })
      ) {
        const upload = await uploadRequestBodyInParts({
          url: requestUrl,
          headers,
          compressedBody,
          encoding: contentEncoding as RequestBodyEncoding,
          signal: combinedSignal ?? undefined,
        });
        if (upload) {
          const stripedHeaders: Record<string, string> = { ...encoded.headers };
          // The body now travels beside the request: drop the encoding that
          // described it and carry the upload id instead. The receiver
          // reassembles and decodes the body before its parser runs.
          delete stripedHeaders['content-encoding'];
          stripedHeaders[REQUEST_BODY_UPLOAD_ID_HEADER] = upload.uploadId;
          stripedHeaders['content-type'] = 'application/json';
          dispatchInit = { ...init, headers: stripedHeaders, body: '' };
        }
      }
    } else {
      dispatchInit = { ...init, headers, body: bodyText };
    }
  }

  // The first delta towards a peer can miss (its base expired, or the process
  // restarted between turns). That is a transport-level "resend whole", not a
  // user-visible failure: dispatch the same request again with the full body.
  let fellBackToFullBody = false;
  const dispatch = async (): Promise<RuntimeResponse> => {
    let response = await fetch(requestUrl, {
      ...dispatchInit,
      signal: combinedSignal,
    });
    if (
      usedDelta
      && !fellBackToFullBody
      && headerRecord
      && fullBodyText !== null
      && isDeltaMissOrDowngrade(response)
    ) {
      fellBackToFullBody = true;
      const peerDroppedProtocol = response.status === 400;
      await response.body?.cancel().catch(() => {});
      if (peerDroppedProtocol) forgetUpstreamRequestBodyDeltaCapability(origin);
      const headers: Record<string, string> = {
        ...headerRecord,
        ...(supportsRequestBodyDelta(origin) ? { [REQUEST_BODY_STORE_HEADER]: '1' } : {}),
      };
      const encoded = await maybeCompressUpstreamRequestBody({
        origin,
        headers,
        bodyText: fullBodyText,
      });
      dispatchInit = encoded.compressed
        ? { ...init, headers: encoded.headers, body: encoded.body }
        : { ...init, headers, body: fullBodyText };
      response = await fetch(requestUrl, {
        ...dispatchInit,
        signal: combinedSignal,
      });
    }
    return response;
  };
  const learnAndReturn = (response: RuntimeResponse) => {
    learnUpstreamRequestBodyEncoding(origin, response);
    learnUpstreamBodyUploadCapability(origin, response);
    learnUpstreamRequestBodyDeltaCapability(origin, response);
    if (response.ok && bodyStoredOnPeer && headerRecord && fullBodyText !== null) {
      rememberSentRequestBody({ origin, headers: headerRecord, bodyText: fullBodyText });
    }
    return response;
  };
  try {
    return learnAndReturn(await dispatch());
  } catch (error) {
    // One transparent retry when a dead keep-alive socket failed the request
    // before anything was received: the body is still intact, our own deadline
    // has not fired, so re-issuing on a fresh connection is strictly better than
    // failing the user's request over a connection the peer had already closed.
    // Only this narrow case retries — DNS, TLS and genuine network failures still
    // surface immediately. Executors that own a transport retry of their own
    // (antigravity walks a list of base URLs across this same error) opt out, so
    // the two policies never interleave.
    const retryable = options?.disableTransportRetry !== true
      && isStaleConnectionFailure(error)
      && isReplayableBody(init.body)
      && combinedSignal?.aborted !== true;
    if (!retryable) throw enrichTransportFailure(error);
    try {
      return learnAndReturn(await dispatch());
    } catch (retryError) {
      throw enrichTransportFailure(retryError);
    }
  }
}

function hasZstdContentEncoding(contentEncoding: string | null): boolean {
  return getContentEncodings(contentEncoding).some((encoding) => encoding === 'zstd');
}

function getContentEncodings(contentEncoding: string | null): string[] {
  if (!contentEncoding) return [];
  return contentEncoding
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);
}

function getOutermostContentEncoding(contentEncoding: string | null): string | null {
  const encodings = getContentEncodings(contentEncoding);
  return encodings.length > 0 ? encodings[encodings.length - 1] : null;
}

function looksLikeZstdFrame(buffer: Buffer): boolean {
  return buffer.length >= 4
    && buffer[0] === 0x28
    && buffer[1] === 0xb5
    && buffer[2] === 0x2f
    && buffer[3] === 0xfd;
}

async function decodeRuntimeResponseBuffer(
  buffer: Buffer,
  contentEncoding: string | null,
  maxOutputLength?: number,
): Promise<Buffer> {
  if (!contentEncoding) return buffer;

  let decoded = buffer;
  const encodings = getContentEncodings(contentEncoding).reverse();
  const options = maxOutputLength === undefined ? undefined : { maxOutputLength };
  for (const encoding of encodings) {
    if (encoding === 'zstd') { decoded = await zstdDecompressAsync(decoded, options); continue; }
    if (encoding === 'br') { decoded = await brotliDecompressAsync(decoded, options); continue; }
    if (encoding === 'gzip' || encoding === 'x-gzip') { decoded = await gunzipAsync(decoded, options); continue; }
    if (encoding === 'deflate') { decoded = await inflateAsync(decoded, options); continue; }
  }

  return decoded;
}

function decodeRuntimeResponseStream(
  stream: Readable,
  contentEncoding: string | null,
): Readable {
  if (!contentEncoding) return stream;

  let decoded = stream;
  const encodings = getContentEncodings(contentEncoding).reverse();

  for (const encoding of encodings) {
    if (encoding === 'zstd') {
      decoded = decoded.pipe(createZstdDecompress()) as Readable;
      continue;
    }
    if (encoding === 'br') {
      decoded = decoded.pipe(createBrotliDecompress()) as Readable;
      continue;
    }
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      decoded = decoded.pipe(createGunzip()) as Readable;
      continue;
    }
    if (encoding === 'deflate') {
      decoded = decoded.pipe(createInflate()) as Readable;
      continue;
    }
  }

  return decoded;
}

// Whole-body reads are used for upstream error bodies and non-stream
// fallbacks. Cap the decoded text so a pathological upstream (multi-MB
// HTML error page) cannot balloon process memory. 1 MiB is far beyond any
// meaningful API error payload while keeping diagnostics intact.
const MAX_RUNTIME_RESPONSE_TEXT_CHARS = 1024 * 1024;

/**
 * Successful JSON bodies forwarded to the client (images b64_json, embedding
 * vectors, non-stream completions, search results) can legitimately exceed
 * 1 MiB; routes opt into this cap. Still bounded — an upstream cannot grow
 * the process heap without limit — but large enough that normal payloads
 * round-trip parseable instead of being corrupted mid-JSON.
 */
export const MAX_JSON_UPSTREAM_BODY_TEXT_CHARS = 8 * 1024 * 1024;

function truncateRuntimeResponseText(text: string, maxChars: number = MAX_RUNTIME_RESPONSE_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function resolveRuntimeBodyMaxChars(options: ReadRuntimeResponseTextOptions): number {
  const value = options.maxChars;
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_JSON_UPSTREAM_BODY_TEXT_CHARS)
    : MAX_RUNTIME_RESPONSE_TEXT_CHARS;
}

function runtimeBodyOverflowError(maxChars: number): Error {
  return new Error(`upstream response body exceeds ${maxChars} chars`);
}

export type ReadRuntimeResponseTextOptions = {
  /** Maximum silence between body chunks. Zero/omitted disables this guard. */
  idleTimeoutMs?: number;
  /** Abort a pending body read when the downstream request is gone. */
  signal?: AbortSignal;
  /**
   * Maximum characters kept from the body. Defaults to
   * MAX_RUNTIME_RESPONSE_TEXT_CHARS (right-sized for error diagnostics);
   * routes that forward a successful JSON body to the client opt into
   * MAX_JSON_UPSTREAM_BODY_TEXT_CHARS so a legitimate multi-MiB b64_json
   * image or dense embedding array is not corrupted mid-parse.
   */
  maxChars?: number;
  /** A forwarded success body must be complete, never truncated to invalid JSON. */
  rejectOnOverflow?: boolean;
};

function buildResponseBodyIdleTimeoutMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `response body idle timeout (${seconds}s)`;
}

function buildResponseBodyAbortError(): Error {
  const error = new Error('response body read aborted');
  error.name = 'AbortError';
  return error;
}

async function readRuntimeResponseTextWithGuards(
  response: RuntimeResponse,
  options: ReadRuntimeResponseTextOptions,
): Promise<string> {
  const contentEncoding = typeof response.headers?.get === 'function'
    ? response.headers.get('content-encoding')
    : null;
  const encodings = getContentEncodings(contentEncoding);

  // Guards (idle deadline / abort) must apply to EVERY body, encoded or not:
  // a plain JSON body that stops mid-flight is exactly the hang this guards.
  // Bound the buffered raw bytes as well as the decoded text: final-text
  // truncation alone cannot stop an indefinitely streaming upstream.
  const body = response.body as globalThis.ReadableStream<Uint8Array> | null | undefined;
  const reader = body?.getReader();
  if (!reader) return '';
  const maxChars = resolveRuntimeBodyMaxChars(options);
  const maxRawBytes = maxChars * 4; // worst-case UTF-8 bytes per code point
  const timeoutMs = Math.max(0, Math.trunc(options.idleTimeoutMs ?? 0));
  const signal = options.signal;
  const chunks: Buffer[] = [];
  let rawBytes = 0;
  let readerReleased = false;
  let cancelled = false;

  const cancelReader = async (reason: unknown): Promise<void> => {
    if (cancelled) return;
    cancelled = true;
    try {
      await reader.cancel(reason);
    } catch {
      // Ignore cancellation errors from already-closed/aborted bodies.
    }
  };

  const releaseReader = (): void => {
    if (readerReleased) return;
    readerReleased = true;
    try {
      reader.releaseLock();
    } catch {
      // Ignore release errors from an already released reader.
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        const error = signal.reason instanceof Error ? signal.reason : buildResponseBodyAbortError();
        await cancelReader(error);
        throw error;
      }

      const next = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          callback();
        };
        const onAbort = (): void => {
          const error = signal?.reason instanceof Error ? signal.reason : buildResponseBodyAbortError();
          finish(() => reject(error));
          void cancelReader(error);
        };

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            const error = new Error(buildResponseBodyIdleTimeoutMessage(timeoutMs));
            finish(() => reject(error));
            void cancelReader(error);
          }, timeoutMs);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        reader.read().then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
      });

      if (next.done) break;
      if (next.value?.byteLength) {
        const chunk = Buffer.from(next.value);
        rawBytes += chunk.length;
        if (rawBytes > maxRawBytes) {
          await cancelReader(runtimeBodyOverflowError(maxChars));
          if (options.rejectOnOverflow) throw runtimeBodyOverflowError(maxChars);
          return `${truncateRuntimeResponseText(Buffer.concat(chunks).toString('utf8'), maxChars)}\n...[truncated after ${rawBytes} raw bytes]`;
        }
        chunks.push(chunk);
      }
    }

    const rawBuffer = Buffer.concat(chunks);
    if (encodings.length === 0) {
      const text = rawBuffer.toString('utf8');
      if (options.rejectOnOverflow && text.length > maxChars) throw runtimeBodyOverflowError(maxChars);
      return truncateRuntimeResponseText(text, maxChars);
    }
    try {
      const text = (await decodeRuntimeResponseBuffer(rawBuffer, contentEncoding, maxChars * 4)).toString('utf8');
      if (options.rejectOnOverflow && text.length > maxChars) throw runtimeBodyOverflowError(maxChars);
      return truncateRuntimeResponseText(text, maxChars);
    } catch (error) {
      if (options.rejectOnOverflow) throw error;
      return looksLikeZstdFrame(rawBuffer) ? '' : truncateRuntimeResponseText(rawBuffer.toString('utf8'), maxChars);
    }
  } finally {
    releaseReader();
  }
}

async function readUnguardedRuntimeResponseText(
  response: RuntimeResponse,
  options: ReadRuntimeResponseTextOptions,
): Promise<string> {
  const maxChars = resolveRuntimeBodyMaxChars(options);
  const contentEncoding = typeof response.headers?.get === 'function'
    ? response.headers.get('content-encoding')
    : null;
  const encodings = getContentEncodings(contentEncoding);
  if (encodings.length === 0) {
    return typeof response.text === 'function'
      ? response.text().then((text) => {
        if (options.rejectOnOverflow && text.length > maxChars) throw runtimeBodyOverflowError(maxChars);
        return truncateRuntimeResponseText(text, maxChars);
      }).catch((error) => {
        if (options.rejectOnOverflow) throw error;
        return '';
      })
      : '';
  }

  // 有任意 content-encoding（gzip/br/deflate/zstd 等）时，统一走显式解压，
  // 避免某些环境下 fetch 实现不解压导致 .text() 返回乱码。
  const rawBuffer = Buffer.from(await response.arrayBuffer());
  try {
    const text = (await decodeRuntimeResponseBuffer(rawBuffer, contentEncoding, maxChars * 4)).toString('utf8');
    if (options.rejectOnOverflow && text.length > maxChars) throw runtimeBodyOverflowError(maxChars);
    return truncateRuntimeResponseText(text, maxChars);
  } catch (error) {
    if (options.rejectOnOverflow) throw error;
    return looksLikeZstdFrame(rawBuffer) ? '' : truncateRuntimeResponseText(rawBuffer.toString('utf8'), maxChars);
  }
}

export async function readRuntimeResponseText(
  response: RuntimeResponse,
  options: ReadRuntimeResponseTextOptions = {},
): Promise<string> {
  if (options.signal || options.idleTimeoutMs !== undefined || options.maxChars !== undefined) {
    return readRuntimeResponseTextWithGuards(response, options);
  }
  return readUnguardedRuntimeResponseText(response, options);
}

function asNodeReadableStream(
  stream: globalThis.ReadableStream<Uint8Array>,
): NodeReadableStream<any> {
  return stream as unknown as NodeReadableStream<any>;
}

function asWebReadableStream(
  stream: NodeReadableStream<any>,
): globalThis.ReadableStream<Uint8Array> {
  return stream as unknown as globalThis.ReadableStream<Uint8Array>;
}

function prependReadableStreamChunks(
  initialChunks: Uint8Array[],
  sourceReader: ReadableStreamDefaultReader<Uint8Array>,
): globalThis.ReadableStream<Uint8Array> {
  const pendingChunks = [...initialChunks];
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const nextPendingChunk = pendingChunks.shift();
      if (nextPendingChunk) {
        controller.enqueue(nextPendingChunk);
        return;
      }

      const nextChunk = await sourceReader.read();
      if (nextChunk.done) {
        controller.close();
        return;
      }

      controller.enqueue(nextChunk.value);
    },
    cancel(reason) {
      return sourceReader.cancel(reason);
    },
  });
}

async function resolveRuntimeResponseReader(
  sourceReader: ReadableStreamDefaultReader<Uint8Array>,
  contentEncoding: string | null,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const initialChunks: Uint8Array[] = [];
  let probeBuffer = Buffer.alloc(0);

  while (probeBuffer.length < 4) {
    const nextChunk = await sourceReader.read();
    if (nextChunk.done) {
      break;
    }
    if (!nextChunk.value || nextChunk.value.byteLength === 0) {
      continue;
    }

    initialChunks.push(nextChunk.value);
    probeBuffer = Buffer.concat([probeBuffer, Buffer.from(nextChunk.value)]);
  }

  if (initialChunks.length === 0) {
    return sourceReader;
  }

  const reconstructedBody = prependReadableStreamChunks(initialChunks, sourceReader);
  const outermostEncoding = getOutermostContentEncoding(contentEncoding);
  if (outermostEncoding === 'zstd' && !looksLikeZstdFrame(probeBuffer)) {
    return reconstructedBody.getReader();
  }

  const decoded = decodeRuntimeResponseStream(
    Readable.fromWeb(asNodeReadableStream(reconstructedBody)),
    contentEncoding,
  );
  return asWebReadableStream(Readable.toWeb(decoded)).getReader();
}

export function getRuntimeResponseReader(
  response: RuntimeResponse,
): ReadableStreamDefaultReader<Uint8Array> | undefined {
  const body = response.body as globalThis.ReadableStream<Uint8Array> | null | undefined;
  if (!body) return undefined;

  const contentEncoding = typeof response.headers?.get === 'function'
    ? response.headers.get('content-encoding')
    : null;
  if (!hasZstdContentEncoding(contentEncoding)) {
    return body.getReader();
  }

  const sourceReader = body.getReader();
  let resolvedReaderPromise: Promise<ReadableStreamDefaultReader<Uint8Array>> | null = null;
  const ensureResolvedReader = () => {
    if (!resolvedReaderPromise) {
      resolvedReaderPromise = resolveRuntimeResponseReader(sourceReader, contentEncoding);
    }
    return resolvedReaderPromise;
  };

  // Keep the public API synchronous while delaying the zstd probe until the first read.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const reader = await ensureResolvedReader();
      const nextChunk = await reader.read();
      if (nextChunk.done) {
        controller.close();
        return;
      }

      controller.enqueue(nextChunk.value);
    },
    async cancel(reason) {
      if (!resolvedReaderPromise) {
        await sourceReader.cancel(reason);
        return;
      }

      const reader = await resolvedReaderPromise.catch(() => sourceReader);
      await reader.cancel(reason);
    },
  }).getReader();
}

export async function materializeErrorResponse(
  response: RuntimeResponse,
): Promise<RuntimeResponse> {
  if (response.ok) return response;
  const text = await readRuntimeResponseText(response);
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(text, {
    status: response.status,
    headers,
  });
}
