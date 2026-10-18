import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import {
  extractResponsesTerminalResponseId,
  isResponsesPreviousResponseNotFoundError,
  shouldInferResponsesPreviousResponseId,
  stripResponsesPreviousResponseId,
  withResponsesPreviousResponseId,
} from '../../transformers/openai/responses/continuation.js';
import {
  buildCodexWebsocketHandshakeHeaders,
  buildCodexWebsocketRequestBody,
  toCodexWebsocketUrl,
} from './codexWebsocketHeaders.js';
import {
  clearCodexSessionResponseId,
  getCodexSessionResponseId,
  setCodexSessionResponseId,
} from './codexSessionResponseStore.js';
import { createCodexWebsocketSessionStore } from './codexWebsocketSessionStore.js';
import { resolveProxyStreamIdleTimeoutMs } from '../../config.js';
import { asTrimmedString } from '../../shared/trimString.js';
import type {

  CodexWebsocketRuntimeResult,
  CodexWebsocketRuntimeSendInput,
  CodexWebsocketSession,
  CodexWebsocketSessionStore,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTerminalEvent(payload: Record<string, unknown>): boolean {
  const type = asTrimmedString(payload.type);
  return type === 'response.completed'
    || type === 'response.failed'
    || type === 'response.incomplete'
    || type === 'error';
}

function isRuntimeErrorEvent(payload: Record<string, unknown>): boolean {
  const type = asTrimmedString(payload.type);
  return type === 'error';
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractFailureTerminalStatus(payload: Record<string, unknown>): number {
  const response = isRecord(payload.response) ? payload.response : null;
  const responseError = response && isRecord(response.error) ? response.error : null;
  const topLevelError = isRecord(payload.error) ? payload.error : null;
  const candidates = [
    payload.status,
    payload.statusCode,
    payload.code,
    topLevelError?.status,
    topLevelError?.statusCode,
    topLevelError?.code,
    responseError?.status,
    responseError?.statusCode,
    responseError?.code,
  ];
  for (const candidate of candidates) {
    const status = asFiniteNumber(candidate);
    if (status !== undefined) return status;
  }
  return 502;
}

function extractTerminalErrorMessage(payload: Record<string, unknown>): string {
  const type = asTrimmedString(payload.type);
  if (type === 'error' && isRecord(payload.error)) {
    return asTrimmedString(payload.error.message) || 'upstream websocket error';
  }
  if ((type === 'response.failed' || type === 'response.incomplete') && isRecord(payload.response)) {
    if (isRecord(payload.response.error)) {
      return asTrimmedString(payload.response.error.message) || `upstream ${type}`;
    }
    if (isRecord(payload.response.incomplete_details)) {
      return asTrimmedString(payload.response.incomplete_details.reason) || `upstream ${type}`;
    }
  }
  return `upstream ${type || 'websocket error'}`;
}

export class CodexWebsocketRuntimeError extends Error {
  events: Array<Record<string, unknown>>;
  status?: number;
  payload?: unknown;

  constructor(
    message: string,
    options?: {
      events?: Array<Record<string, unknown>>;
      status?: number;
      payload?: unknown;
    },
  ) {
    super(message);
    this.name = 'CodexWebsocketRuntimeError';
    this.events = options?.events ?? [];
    this.status = options?.status;
    this.payload = options?.payload;
  }
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Cap on a non-101 upgrade response body: enough for an error page, not a DoS. */
const UNEXPECTED_RESPONSE_MAX_BYTES = 64 * 1024;
/** Give up on a stalled non-101 response body after this much silence. */
const UNEXPECTED_RESPONSE_IDLE_MS = 10_000;
/** Cap on the websocket upgrade handshake. */
const SOCKET_OPEN_TIMEOUT_MS = 30_000;
/** Upper bound on closeSession waiting for an in-flight send to settle. */
const CLOSE_SESSION_DRAIN_MS = 2_000;

async function readUnexpectedResponseBody(response: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (body: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      response.off('data', onData);
      response.off('end', onEnd);
      response.off('error', onError);
      response.destroy();
      resolve(body);
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf8')), UNEXPECTED_RESPONSE_IDLE_MS);
      timer.unref?.();
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes <= UNEXPECTED_RESPONSE_MAX_BYTES) chunks.push(buffer);
      if (bytes >= UNEXPECTED_RESPONSE_MAX_BYTES) {
        finish(Buffer.concat(chunks).toString('utf8'));
        return;
      }
      arm();
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'));
    const onError = () => finish('');
    response.on('data', onData);
    response.once('end', onEnd);
    response.once('error', onError);
    arm();
  });
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  if (socket.readyState !== WebSocket.CONNECTING) {
    throw new Error('upstream websocket is not open');
  }
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('unexpected-response', onUnexpectedResponse);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('upstream websocket closed before opening'));
    };
    const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
      void readUnexpectedResponseBody(response).then((body) => {
        cleanup();
        reject(new CodexWebsocketRuntimeError(
          body.trim() || response.statusMessage || `upstream websocket upgrade failed with status ${response.statusCode || 502}`,
          {
            status: response.statusCode || 502,
            payload: tryParseJson(body),
          },
        ));
      });
    };
    timer = setTimeout(() => {
      cleanup();
      try { socket.terminate(); } catch { /* already closing */ }
      reject(new Error(`upstream websocket handshake timed out (${SOCKET_OPEN_TIMEOUT_MS / 1000}s)`));
    }, SOCKET_OPEN_TIMEOUT_MS);
    timer.unref?.();
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('unexpected-response', onUnexpectedResponse);
  });
}

async function closeSocket(socket: WebSocket | null): Promise<void> {
  if (!socket) return;
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const onClose = () => resolve();
    socket.once('close', onClose);
    try {
      socket.close();
    } catch {
      socket.off('close', onClose);
      resolve();
    }
    setTimeout(() => {
      socket.off('close', onClose);
      resolve();
    }, 200);
  });
}

function clearSessionSocket(session: CodexWebsocketSession, socket: WebSocket): void {
  if (session.socket !== socket) return;
  session.socket = null;
  session.socketUrl = null;
}

function buildContinuationAwareRuntimeBody(
  sessionId: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const rememberedResponseId = getCodexSessionResponseId(sessionId);
  if (!shouldInferResponsesPreviousResponseId(body, rememberedResponseId)) {
    return body;
  }
  return withResponsesPreviousResponseId(body, rememberedResponseId);
}

function rememberSessionResponseId(sessionId: string, payload: unknown): void {
  const responseId = extractResponsesTerminalResponseId(payload);
  if (!responseId) return;
  setCodexSessionResponseId(sessionId, responseId);
}

async function ensureSessionSocket(
  session: CodexWebsocketSession,
  input: CodexWebsocketRuntimeSendInput,
): Promise<{ socket: WebSocket; reusedSession: boolean }> {
  const requestUrl = toCodexWebsocketUrl(input.requestUrl);
  const existing = session.socket;
  if (
    existing
    && session.socketUrl === requestUrl
    && existing.readyState === WebSocket.OPEN
  ) {
    return {
      socket: existing,
      reusedSession: true,
    };
  }

  if (existing) {
    await closeSocket(existing);
    clearSessionSocket(session, existing);
  }

  const nextSocket = new WebSocket(requestUrl, {
    headers: buildCodexWebsocketHandshakeHeaders(input.headers),
  });
  await waitForSocketOpen(nextSocket);
  session.socket = nextSocket;
  session.socketUrl = requestUrl;

  nextSocket.on('close', () => {
    clearSessionSocket(session, nextSocket);
  });
  nextSocket.on('error', () => {
    clearSessionSocket(session, nextSocket);
  });

  return {
    socket: nextSocket,
    reusedSession: false,
  };
}

async function sendSessionRequestAttempt(
  session: CodexWebsocketSession,
  input: CodexWebsocketRuntimeSendInput & {
    body: Record<string, unknown>;
  },
): Promise<CodexWebsocketRuntimeResult> {
  const { socket, reusedSession } = await ensureSessionSocket(session, input);
  const events: Array<Record<string, unknown>> = [];
  const idleMs = resolveProxyStreamIdleTimeoutMs();

  return new Promise<CodexWebsocketRuntimeResult>((resolve, reject) => {
    let settled = false;
    let idleTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    const armIdleTimer = () => {
      if (idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        clearSessionSocket(session, socket);
        void closeSocket(socket);
        rejectWith(`upstream websocket idle timeout (${Math.round(idleMs / 1000)}s)`);
      }, idleMs);
      idleTimer.unref?.();
    };

    const rejectWith = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CodexWebsocketRuntimeError(message, { events: [...events] }));
    };

    const onMessage = (payload: WebSocket.RawData) => {
      // Any frame — including keepalives — proves the upstream is alive.
      armIdleTimer();
      try {
        const parsed = JSON.parse(String(payload));
        if (!isRecord(parsed)) return;
        events.push(parsed);
        if (!isTerminalEvent(parsed)) return;
        if (settled) return;
        if (
          isRuntimeErrorEvent(parsed)
          || isResponsesPreviousResponseNotFoundError({
            payload: parsed,
            rawErrText: extractTerminalErrorMessage(parsed),
          })
        ) {
          settled = true;
          cleanup();
          clearSessionSocket(session, socket);
          void closeSocket(socket);
          reject(new CodexWebsocketRuntimeError(extractTerminalErrorMessage(parsed), {
            events: [...events],
            status: extractFailureTerminalStatus(parsed),
            payload: parsed,
          }));
          return;
        }
        rememberSessionResponseId(session.sessionId, parsed);
        settled = true;
        cleanup();
        resolve({
          events: [...events],
          reusedSession,
        });
      } catch {
        // Ignore malformed frames and wait for a terminal event.
      }
    };

    const onError = (error: Error) => {
      clearSessionSocket(session, socket);
      rejectWith(error.message || 'upstream websocket error');
    };

    const onClose = () => {
      clearSessionSocket(session, socket);
      rejectWith('stream closed before response.completed');
    };

    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
    armIdleTimer();

    socket.send(JSON.stringify(buildCodexWebsocketRequestBody(input.body)), (error?: Error) => {
      if (!error) return;
      clearSessionSocket(session, socket);
      rejectWith(error.message || 'failed to send upstream websocket request');
    });
  });
}

async function sendSessionRequest(
  session: CodexWebsocketSession,
  input: CodexWebsocketRuntimeSendInput,
): Promise<CodexWebsocketRuntimeResult> {
  let currentBody = buildContinuationAwareRuntimeBody(session.sessionId, input.body);
  let previousResponseRecoveryTried = false;

  for (;;) {
    try {
      return await sendSessionRequestAttempt(session, {
        ...input,
        body: currentBody,
      });
    } catch (error) {
      if (
        previousResponseRecoveryTried
        || !(error instanceof CodexWebsocketRuntimeError)
        || !isResponsesPreviousResponseNotFoundError({
          payload: error.payload ?? error.events[error.events.length - 1],
          rawErrText: error.message,
        })
      ) {
        throw error;
      }

      const previousResponseRecovery = stripResponsesPreviousResponseId(currentBody);
      if (!previousResponseRecovery.removed) {
        throw error;
      }

      previousResponseRecoveryTried = true;
      clearCodexSessionResponseId(session.sessionId);
      currentBody = previousResponseRecovery.body;
    }
  }
}

export function createCodexWebsocketRuntime(input?: {
  sessionStore?: CodexWebsocketSessionStore;
}) {
  const sessionStore = input?.sessionStore || createCodexWebsocketSessionStore();

  return {
    async sendRequest(payload: CodexWebsocketRuntimeSendInput): Promise<CodexWebsocketRuntimeResult> {
      const sessionId = payload.sessionId.trim();
      if (!sessionId) {
        throw new CodexWebsocketRuntimeError('missing websocket session id');
      }

      const session = sessionStore.getOrCreate(sessionId);
      const run = session.queue
        .catch(() => undefined)
        .then(async () => {
          session.lastUsedAt = Date.now();
          session.inFlight += 1;
          try {
            return await sendSessionRequest(session, payload);
          } finally {
            session.inFlight -= 1;
            session.lastUsedAt = Date.now();
          }
        });
      session.queue = run.then(() => undefined, () => undefined);
      return run;
    },

    async closeSession(sessionId: string): Promise<void> {
      const session = sessionStore.take(sessionId);
      if (!session) return;
      // Never block on a send that may never settle — the whole point of this
      // call is to reclaim the upstream socket once the downstream is gone.
      await Promise.race([
        session.queue.catch(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CLOSE_SESSION_DRAIN_MS);
          timer.unref?.();
        }),
      ]);
      await closeSocket(session.socket);
      session.socket = null;
      session.socketUrl = null;
      // Intentionally preserve the remembered previous_response_id across
      // websocket reconnects. Closing a transport session should not sever the
      // logical downstream continuation chain for the same session key.
    },

    async closeAllSessions(): Promise<void> {
      const sessions = sessionStore.list();
      for (const session of sessions) {
        await this.closeSession(session.sessionId);
      }
    },
  };
}
