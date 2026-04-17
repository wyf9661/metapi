import { describe, expect, it } from 'vitest';

import {
  createGeminiCliStreamReader,
  unwrapGeminiCliPayload,
  wrapGeminiCliRequest,
} from './cliBridge.js';

describe('gemini cli bridge', () => {
  it('wraps Gemini CLI requests with project and stripped request model', () => {
    expect(wrapGeminiCliRequest({
      modelName: 'models/gemini-2.5-pro',
      projectId: 'project-123',
      request: {
        model: 'ignored-model',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    })).toEqual({
      project: 'project-123',
      model: 'models/gemini-2.5-pro',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });
  });

  it('unwraps Gemini CLI payload envelopes to the response body', () => {
    expect(unwrapGeminiCliPayload({ response: { ok: true }, project: 'p' })).toEqual({ ok: true });
    expect(unwrapGeminiCliPayload({ ok: true })).toEqual({ ok: true });
    expect(unwrapGeminiCliPayload('raw')).toBe('raw');
  });

  it('rewrites SSE data blocks to the inner Gemini CLI response payload', async () => {
    const chunks = [
      Buffer.from('data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}}\n\n'),
      Buffer.from('data: [DONE]\n\n'),
    ];
    let index = 0;
    const reader = createGeminiCliStreamReader({
      async read() {
        if (index >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: new Uint8Array(chunks[index++]) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    });

    const first = await reader.read();
    const second = await reader.read();
    const third = await reader.read();

    expect(Buffer.from(first.value ?? []).toString('utf8')).toContain('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}');
    expect(Buffer.from(second.value ?? []).toString('utf8')).toBe('data: [DONE]\n\n');
    expect(third.done).toBe(true);
  });
});
