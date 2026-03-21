import { gzipSync, zstdCompressSync } from 'node:zlib';
import { Response } from 'undici';
import { describe, expect, it } from 'vitest';
import { materializeErrorResponse, readRuntimeResponseText } from './types.js';

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
