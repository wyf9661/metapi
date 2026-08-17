import type { Response as UndiciResponse, Headers as UndiciHeaders } from 'undici';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';
import type {
  EndpointAttemptSuccessContext,
} from '../proxy-core/orchestration/endpointFlow.js';
import {
  finalizeProxyDebugTrace,
  insertProxyDebugAttempt,
  normalizeProxyDebugResponseHeaders,
  startProxyDebugTraceSession,
  updateProxyDebugAttempt,
  updateProxyDebugTraceCandidates,
  updateProxyDebugTraceSelection,
  type ProxyDebugTraceSession,
  type HeadersLike,
} from './proxyDebugTraceStore.js';

export type RouteDecisionTraceEvent = {
  sequence: number;
  stage: 'selection' | 'candidates' | 'endpoint_attempt' | 'final';
  recordedAt: string;
  details: Record<string, unknown>;
};

type MutableProxyDebugTraceSession = ProxyDebugTraceSession & {
  nextAttemptIndex?: number;
  routeDecisionEvents?: RouteDecisionTraceEvent[];
};

export function appendRouteDecisionTraceEvent(
  session: ProxyDebugTraceSession | null,
  stage: RouteDecisionTraceEvent['stage'],
  details: Record<string, unknown>,
): RouteDecisionTraceEvent[] {
  if (!session) return [];
  const mutableSession = session as MutableProxyDebugTraceSession;
  const events = mutableSession.routeDecisionEvents ?? [];
  events.push({
    sequence: events.length,
    stage,
    recordedAt: new Date().toISOString(),
    details,
  });
  mutableSession.routeDecisionEvents = events;
  return [...events];
}

function withRouteDecisionEvents(
  session: ProxyDebugTraceSession | null,
  decisionSummary: unknown,
): unknown {
  if (!session) return decisionSummary;
  const events = (session as MutableProxyDebugTraceSession).routeDecisionEvents ?? [];
  if (decisionSummary && typeof decisionSummary === 'object' && !Array.isArray(decisionSummary)) {
    return {
      ...(decisionSummary as Record<string, unknown>),
      routeDecisionEvents: [...events],
    };
  }
  return {
    summary: decisionSummary ?? null,
    routeDecisionEvents: [...events],
  };
}

function parseDebugTextPayload(rawText: string): unknown {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

export async function startSurfaceProxyDebugTrace(input: {
  downstreamPath: string;
  clientKind?: string | null;
  sessionId?: string | null;
  traceHint?: string | null;
  requestedModel?: string | null;
  downstreamApiKeyId?: number | null;
  requestHeaders?: Record<string, unknown>;
  requestBody?: unknown;
}): Promise<ProxyDebugTraceSession | null> {
  try {
    return await startProxyDebugTraceSession(input);
  } catch (error) {
    console.warn('[proxy-debug] failed to create trace session', error);
    return null;
  }
}

export async function safeUpdateSurfaceProxyDebugSelection(
  session: ProxyDebugTraceSession | null,
  input: Parameters<typeof updateProxyDebugTraceSelection>[1],
): Promise<void> {
  if (!session) return;
  appendRouteDecisionTraceEvent(session, 'selection', { ...input });
  try {
    await updateProxyDebugTraceSelection(session.traceId, input);
    await updateProxyDebugTraceCandidates(session.traceId, {
      decisionSummary: withRouteDecisionEvents(session, null),
    });
  } catch (error) {
    console.warn('[proxy-debug] failed to update selection', error);
  }
}

export async function safeUpdateSurfaceProxyDebugCandidates(
  session: ProxyDebugTraceSession | null,
  input: Parameters<typeof updateProxyDebugTraceCandidates>[1],
): Promise<void> {
  if (!session) return;
  appendRouteDecisionTraceEvent(session, 'candidates', {
    endpointCandidates: input.endpointCandidates ?? null,
    endpointRuntimeState: input.endpointRuntimeState ?? null,
    decisionSummary: input.decisionSummary ?? null,
  });
  try {
    await updateProxyDebugTraceCandidates(session.traceId, {
      ...input,
      decisionSummary: withRouteDecisionEvents(session, input.decisionSummary),
    });
  } catch (error) {
    console.warn('[proxy-debug] failed to update endpoint candidates', error);
  }
}

export async function safeInsertSurfaceProxyDebugAttempt(
  session: ProxyDebugTraceSession | null,
  input: Omit<Parameters<typeof insertProxyDebugAttempt>[0], 'traceId'>,
): Promise<void> {
  if (!session) return;
  appendRouteDecisionTraceEvent(session, 'endpoint_attempt', {
    attemptIndex: input.attemptIndex,
    endpoint: input.endpoint,
    requestPath: input.requestPath,
    targetUrl: input.targetUrl,
    runtimeExecutor: input.runtimeExecutor ?? null,
    responseStatus: input.responseStatus ?? null,
    recoverApplied: input.recoverApplied === true,
    downgradeDecision: input.downgradeDecision === true,
  });
  try {
    await insertProxyDebugAttempt({
      ...input,
      traceId: session.traceId,
      requestHeaders: session.options.captureHeaders ? input.requestHeaders : null,
      requestBody: session.options.captureBodies ? input.requestBody : null,
      responseHeaders: session.options.captureHeaders ? input.responseHeaders : null,
      responseBody: session.options.captureBodies ? input.responseBody : null,
      maxBodyBytes: session.options.maxBodyBytes,
    });
  } catch (error) {
    console.warn('[proxy-debug] failed to insert attempt', error);
  }
}

export function reserveSurfaceProxyDebugAttemptBase(
  session: ProxyDebugTraceSession | null,
  span: number,
): number {
  if (!session) return 0;

  const mutableSession = session as MutableProxyDebugTraceSession;
  const base = mutableSession.nextAttemptIndex ?? 0;
  const normalizedSpan = Number.isFinite(span)
    ? Math.max(1, Math.trunc(span))
    : 1;
  mutableSession.nextAttemptIndex = base + normalizedSpan;
  return base;
}

export async function safeFinalizeSurfaceProxyDebugTrace(
  session: ProxyDebugTraceSession | null,
  input: Parameters<typeof finalizeProxyDebugTrace>[1],
): Promise<void> {
  if (!session) return;
  appendRouteDecisionTraceEvent(session, 'final', {
    finalStatus: input.finalStatus ?? null,
    finalHttpStatus: input.finalHttpStatus ?? null,
    finalUpstreamPath: input.finalUpstreamPath ?? null,
  });
  try {
    await updateProxyDebugTraceCandidates(session.traceId, {
      decisionSummary: withRouteDecisionEvents(session, null),
    });
    await finalizeProxyDebugTrace(session.traceId, {
      ...input,
      finalResponseHeaders: session.options.captureHeaders ? input.finalResponseHeaders : null,
      finalResponseBody: session.options.captureBodies ? input.finalResponseBody : null,
      maxBodyBytes: session.options.maxBodyBytes,
    });
  } catch (error) {
    console.warn('[proxy-debug] failed to finalize trace', error);
  }
}

export async function safeUpdateSurfaceProxyDebugAttempt(
  session: ProxyDebugTraceSession | null,
  attemptIndex: number,
  input: Parameters<typeof updateProxyDebugAttempt>[2],
): Promise<void> {
  if (!session) return;
  try {
    await updateProxyDebugAttempt(session.traceId, attemptIndex, input);
  } catch (error) {
    console.warn('[proxy-debug] failed to update attempt', error);
  }
}

export async function captureSurfaceProxyDebugSuccessResponseBody(
  session: ProxyDebugTraceSession | null,
  ctx: EndpointAttemptSuccessContext,
): Promise<unknown> {
  if (!session?.options.captureBodies) return null;

  const contentType = (ctx.response.headers.get('content-type') || '').toLowerCase();
  const requestBody = ctx.request.body as Record<string, unknown> | undefined;
  const isStream = ctx.request.runtime?.stream === true
    || requestBody?.stream === true
    || contentType.includes('text/event-stream');
  if (isStream) return null;

  try {
    const rawText = await readRuntimeResponseText(ctx.response.clone());
    return parseDebugTextPayload(rawText);
  } catch {
    return null;
  }
}

export function buildSurfaceProxyDebugResponseHeaders(
  response:
    | UndiciResponse
    | UndiciHeaders
    | Headers
    | Record<string, unknown>
    | { headers?: unknown }
    | null
    | undefined,
): Record<string, unknown> | null {
  if (!response) return null;
  // Response objects have a .headers property — extract it
  const maybeHeaders = (response as { headers?: unknown }).headers;
  if (maybeHeaders && typeof maybeHeaders === 'object') {
    return normalizeProxyDebugResponseHeaders(maybeHeaders as HeadersLike);
  }
  // Treat the value itself as headers-like
  return normalizeProxyDebugResponseHeaders(response as HeadersLike);
}

export function parseSurfaceProxyDebugTextPayload(rawText: string): unknown {
  return parseDebugTextPayload(rawText);
}
