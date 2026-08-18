import { describe, expect, it } from 'vitest';

import type { BuiltEndpointRequest } from './endpointFlow.js';
import type { UpstreamEndpoint } from '../../proxy-core/orchestration/upstreamRequest.js';

function requestFor(path: string): BuiltEndpointRequest {
  return {
    endpoint: 'responses',
    path,
    headers: { 'content-type': 'application/json' },
    body: { model: 'gpt-5.2', input: 'hello' },
  };
}

function buildDelayedResponse(
  bodyText: string,
  delayMs: number,
  status = 200,
  signal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const timer = setTimeout(() => {
        if (signal?.aborted) return;
        controller.enqueue(encoder.encode(bodyText));
        controller.close();
      }, delayMs);

      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
      }, { once: true });
    },
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('executeEndpointFlow first-byte timeout', () => {
  it('falls through to the next endpoint candidate when the current endpoint times out before any output', async () => {
    const { executeEndpointFlow } = await import('./endpointFlow.js');
    let timedOutSignal: AbortSignal | undefined;
    const dispatchRequest = async (
      request: BuiltEndpointRequest,
      _targetUrl?: string,
      signal?: AbortSignal,
    ) => (
      request.path === '/v1/responses'
        ? (
          timedOutSignal = signal,
          buildDelayedResponse(JSON.stringify({ ok: false }), 60, 200, signal)
        )
        : new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as Awaited<ReturnType<typeof import('undici').fetch>>;

    const failures: string[] = [];
    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses', 'chat'],
      buildRequest: (endpoint: UpstreamEndpoint) => endpoint === 'responses'
        ? requestFor('/v1/responses')
        : { ...requestFor('/v1/chat/completions'), endpoint },
      dispatchRequest,
      firstByteTimeoutMs: 10,
      onAttemptFailure: (ctx: { errText: string }) => {
        failures.push(ctx.errText);
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.upstreamPath).toBe('/v1/chat/completions');
    }
    expect(timedOutSignal).toBeDefined();
    expect(timedOutSignal?.aborted).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('first byte timeout');
  }, 15_000);

  it('applies the first-byte timeout to recovery dispatches', async () => {
    const { executeEndpointFlow } = await import('./endpointFlow.js');
    let recoverySignal: AbortSignal | undefined;
    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
      dispatchRequest: async (request, _targetUrl, signal) => {
        if (request.body.compatibility === true) {
          recoverySignal = signal;
          return buildDelayedResponse(
            JSON.stringify({ ok: true }),
            60,
            200,
            signal,
          ) as any;
        }
        return new Response(JSON.stringify({ error: 'retry with compatibility body' }), {
          status: 415,
          headers: { 'content-type': 'application/json' },
        }) as unknown as Awaited<ReturnType<typeof import('undici').fetch>>;
      },
      firstByteTimeoutMs: 10,
      tryRecover: async (ctx) => ({
        upstream: await ctx.dispatchRecoveryRequest(
          { ...ctx.request, body: { ...ctx.request.body, compatibility: true } },
          ctx.targetUrl,
        ),
        upstreamPath: ctx.request.path,
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(408);
      expect(result.errText).toContain('first byte timeout');
    }
    expect(recoverySignal).toBeDefined();
    expect(recoverySignal?.aborted).toBe(true);
  });

  it('shares the remaining first-byte budget with recovery dispatches', async () => {
    const { executeEndpointFlow } = await import('./endpointFlow.js');
    const startedAt = Date.now();
    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses'],
      buildRequest: () => requestFor('/v1/responses'),
      dispatchRequest: async (_request, _targetUrl, signal) => buildDelayedResponse(
        JSON.stringify({ error: 'retry with compatibility body' }),
        25,
        415,
        signal,
      ) as unknown as Awaited<ReturnType<typeof import('undici').fetch>>,
      firstByteTimeoutMs: 40,
      tryRecover: async (ctx) => ({
        upstream: await ctx.dispatchRecoveryRequest(
          { ...ctx.request, body: { ...ctx.request.body, compatibility: true } },
          ctx.targetUrl,
        ),
        upstreamPath: ctx.request.path,
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(408);
    expect(Date.now() - startedAt).toBeLessThan(60);
  });

  it('treats first-byte timeout as terminal when cross-protocol fallback is disabled', async () => {
    const { executeEndpointFlow } = await import('./endpointFlow.js');
    const attemptedPaths: string[] = [];
    const result = await executeEndpointFlow({
      siteUrl: 'https://example.com',
      endpointCandidates: ['responses', 'chat'],
      disableCrossProtocolFallback: true,
      buildRequest: (endpoint: UpstreamEndpoint) => endpoint === 'responses'
        ? requestFor('/v1/responses')
        : { ...requestFor('/v1/chat/completions'), endpoint },
      dispatchRequest: async (
        request: BuiltEndpointRequest,
        _targetUrl?: string,
        signal?: AbortSignal,
      ) => {
        attemptedPaths.push(request.path);
        return (
          request.path === '/v1/responses'
            ? buildDelayedResponse(JSON.stringify({ ok: false }), 60, 200, signal)
            : new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
        ) as unknown as Awaited<ReturnType<typeof import('undici').fetch>>;
      },
      firstByteTimeoutMs: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(408);
      expect(result.errText).toContain('first byte timeout');
    }
    expect(attemptedPaths).toEqual(['/v1/responses']);
  });
});
