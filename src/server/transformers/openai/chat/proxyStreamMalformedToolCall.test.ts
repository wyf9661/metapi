import { afterEach, describe, expect, it } from 'vitest';

import { config } from '../../../config.js';
import { createChatProxyStreamSession } from './proxyStream.js';

function readerOf(chunks: string[]) {
  let i = 0;
  return {
    async read() {
      if (i >= chunks.length) return { done: true };
      return { done: false, value: new TextEncoder().encode(chunks[i++]) };
    },
    async cancel() {},
    releaseLock() {},
  };
}

function toolCallChunk(first: Record<string, unknown>) {
  return `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: first }] })}\n\n`;
}

describe('chat proxy stream malformed tool-call gate', () => {
  const originalEmptyFail = config.proxyEmptyContentFailEnabled;

  afterEach(() => {
    config.proxyEmptyContentFailEnabled = originalEmptyFail;
  });

  it('fails a stream whose assembled tool call arguments never parse', async () => {
    config.proxyEmptyContentFailEnabled = true;
    const written: string[] = [];
    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-test',
      successfulUpstreamPath: '/v1/chat/completions',
      writeLines: (lines) => written.push(...lines),
      writeRaw: (chunk) => written.push(chunk),
    });

    const result = await session.run(readerOf([
      toolCallChunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'terminal', arguments: '{"comm' } }] }),
      toolCallChunk({ tool_calls: [{ index: 1, function: { name: 'session_search', arguments: '{"quer' } }] }),
      `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]), { end() {} });

    expect(result).toMatchObject({
      status: 'failed',
      errorMessage: 'Upstream returned malformed tool call arguments',
    });
  });

  it('keeps a stream whose tool call arguments reassemble into valid JSON', async () => {
    config.proxyEmptyContentFailEnabled = true;
    const written: string[] = [];
    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-test',
      successfulUpstreamPath: '/v1/chat/completions',
      writeLines: (lines) => written.push(...lines),
      writeRaw: (chunk) => written.push(chunk),
    });

    const result = await session.run(readerOf([
      toolCallChunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'terminal', arguments: '{"command"' } }] }),
      toolCallChunk({ tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }),
      `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]), { end() {} });

    expect(result).toMatchObject({ status: 'completed', errorMessage: null });
    expect(written.join('')).toContain('"terminal"');
  });
});
