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

export async function performFetch(
  input: RuntimeDispatchInput,
  request: ProxyRuntimeRequest,
  requestUrl = input.targetUrl || buildUpstreamUrl(input.siteUrl, request.path),
  options: { disableTransportRetry?: boolean } = {},
): Promise<RuntimeResponse> {
  const init = await input.buildInit(requestUrl, request);
  const combinedSignal = input.signal && init.signal
    ? AbortSignal.any([input.signal, init.signal as AbortSignal])
    : (input.signal ?? init.signal);
  const dispatch = () => fetch(requestUrl, {
    ...init,
    signal: combinedSignal,
  });
  try {
    return await dispatch();
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
      return await dispatch();
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

async function decodeRuntimeResponseBuffer(buffer: Buffer, contentEncoding: string | null): Promise<Buffer> {
  if (!contentEncoding) return buffer;

  let decoded = buffer;
  const encodings = getContentEncodings(contentEncoding).reverse();

  for (const encoding of encodings) {
    if (encoding === 'zstd') { decoded = await zstdDecompressAsync(decoded); continue; }
    if (encoding === 'br') { decoded = await brotliDecompressAsync(decoded); continue; }
    if (encoding === 'gzip' || encoding === 'x-gzip') { decoded = await gunzipAsync(decoded); continue; }
    if (encoding === 'deflate') { decoded = await inflateAsync(decoded); continue; }
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

function truncateRuntimeResponseText(text: string): string {
  if (text.length <= MAX_RUNTIME_RESPONSE_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_RUNTIME_RESPONSE_TEXT_CHARS)}\n...[truncated ${text.length - MAX_RUNTIME_RESPONSE_TEXT_CHARS} chars]`;
}

export type ReadRuntimeResponseTextOptions = {
  /** Maximum silence between body chunks. Zero/omitted disables this guard. */
  idleTimeoutMs?: number;
  /** Abort a pending body read when the downstream request is gone. */
  signal?: AbortSignal;
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
  // Chunks are collected raw; encoded bodies are decoded whole afterwards —
  // these are bounded error/fallback payloads (1 MiB truncation), so the
  // streaming decoder used for SSE relay is unnecessary here.
  const body = response.body as globalThis.ReadableStream<Uint8Array> | null | undefined;
  const reader = body?.getReader();
  if (!reader) return '';

  const timeoutMs = Math.max(0, Math.trunc(options.idleTimeoutMs ?? 0));
  const signal = options.signal;
  const chunks: Buffer[] = [];
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
      if (next.value?.byteLength) chunks.push(Buffer.from(next.value));
    }

    const rawBuffer = Buffer.concat(chunks);
    if (encodings.length === 0) {
      return truncateRuntimeResponseText(rawBuffer.toString('utf8'));
    }
    try {
      return truncateRuntimeResponseText(
        (await decodeRuntimeResponseBuffer(rawBuffer, contentEncoding)).toString('utf8'),
      );
    } catch {
      return looksLikeZstdFrame(rawBuffer) ? '' : truncateRuntimeResponseText(rawBuffer.toString('utf8'));
    }
  } finally {
    releaseReader();
  }
}

async function readUnguardedRuntimeResponseText(response: RuntimeResponse): Promise<string> {
  const contentEncoding = typeof response.headers?.get === 'function'
    ? response.headers.get('content-encoding')
    : null;
  const encodings = getContentEncodings(contentEncoding);
  if (encodings.length === 0) {
    return typeof response.text === 'function'
      ? response.text().then(truncateRuntimeResponseText).catch(() => '')
      : '';
  }

  // 有任意 content-encoding（gzip/br/deflate/zstd 等）时，统一走显式解压，
  // 避免某些环境下 fetch 实现不解压导致 .text() 返回乱码。
  const rawBuffer = Buffer.from(await response.arrayBuffer());
  try {
    return truncateRuntimeResponseText(
      (await decodeRuntimeResponseBuffer(rawBuffer, contentEncoding)).toString('utf8'),
    );
  } catch {
    return looksLikeZstdFrame(rawBuffer) ? '' : truncateRuntimeResponseText(rawBuffer.toString('utf8'));
  }
}

export async function readRuntimeResponseText(
  response: RuntimeResponse,
  options: ReadRuntimeResponseTextOptions = {},
): Promise<string> {
  if (options.signal || options.idleTimeoutMs !== undefined) {
    return readRuntimeResponseTextWithGuards(response, options);
  }
  return readUnguardedRuntimeResponseText(response);
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
