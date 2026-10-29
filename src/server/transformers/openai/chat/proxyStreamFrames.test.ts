import { describe, expect, it } from 'vitest';

import { createChatProxyStreamSession } from './proxyStream.js';

/**
 * An SSE data line that is not JSON cannot be a valid chunk for either downstream format.
 * It used to be forwarded verbatim to OpenAI clients (`data: {"id":"x","cho` -> client
 * JSON.parse throws) and turned into a text delta for Claude clients (raw JSON inside the
 * answer). Both are now dropped.
 */
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

describe('chat proxy stream unparseable frames', () => {
  it('does not forward a non-JSON frame to an OpenAI client', async () => {
    const written: string[] = [];
    const dropped: string[] = [];
    const session = createChatProxyStreamSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-test',
      successfulUpstreamPath: '/v1/chat/completions',
      onDroppedFrame: (event) => dropped.push(event.data),
      writeLines: (lines) => written.push(...lines),
      writeRaw: (chunk) => written.push(chunk),
    });

    await session.run(readerOf([
      'data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"x","cho\n\n',
    ]), { end() {} });

    const output = written.join('');
    expect(output).toContain('"content":"hi"');
    // `"choices"` contains `"cho`, so match the truncated frame itself.
    expect(output).not.toContain('"id":"x","cho');
    expect(dropped).toHaveLength(1);
  });

  it('does not turn a non-JSON frame into answer text for a Claude client', async () => {
    const written: string[] = [];
    const session = createChatProxyStreamSession({
      downstreamFormat: 'claude',
      modelName: 'claude-test',
      successfulUpstreamPath: '/v1/messages',
      writeLines: (lines) => written.push(...lines),
      writeRaw: (chunk) => written.push(chunk),
    });

    await session.run(readerOf([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test"}}\n\n',
      'data: {"id":"x","cho\n\n',
    ]), { end() {} });

    expect(written.join('')).not.toContain('"id":"x","cho');
  });
});
