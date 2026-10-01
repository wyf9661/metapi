import { gzipSync, zstdCompressSync } from 'node:zlib';
import { Response } from 'undici';
import { describe, expect, it } from 'vitest';
import { enrichTransportFailure, getRuntimeResponseReader, materializeErrorResponse, performFetch, readRuntimeResponseText } from './types.js';

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
