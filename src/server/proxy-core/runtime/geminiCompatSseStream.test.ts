import { describe, expect, it } from 'vitest';
import { relayOpenAiChatSseToGeminiSse } from './geminiCompatSseStream.js';

function readerFrom(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (index >= chunks.length) return { done: true };
      const value = encoder.encode(chunks[index]);
      index += 1;
      return { done: false, value };
    },
    async cancel() {
      return undefined;
    },
    releaseLock() {},
  };
}

function parseChunks(lines: string[]): Array<Record<string, any>> {
  return lines
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

const upstreamFrames = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"想一想"}}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"你好"}}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"，世界"}}]}\n\n',
  // finish_reason first, usage chunk after it — exactly how new-api relays report counts.
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":9,"total_tokens":129,"prompt_tokens_details":{"cached_tokens":64}}}\n\n',
  'data: [DONE]\n\n',
];

describe('gemini compat SSE relay', () => {
  it('streams content as gemini chunks instead of leaking raw SSE text', async () => {
    const lines: string[] = [];
    const result = await relayOpenAiChatSseToGeminiSse({
      reader: readerFrom(upstreamFrames),
      modelName: 'qwen3.8-flash',
      responseId: 'resp_test',
      write: (line) => lines.push(line),
    });

    const chunks = parseChunks(lines);
    const texts = chunks
      .flatMap((chunk) => chunk.candidates?.[0]?.content?.parts ?? [])
      .map((part: Record<string, unknown>) => part.text);
    expect(texts).toContain('你好');
    expect(texts).toContain('，世界');
    expect(lines.join('')).not.toContain('\\"choices\\"');

    // Reasoning deltas must stay flagged as thought parts.
    const thoughtParts = chunks
      .flatMap((chunk) => chunk.candidates?.[0]?.content?.parts ?? [])
      .filter((part: Record<string, unknown>) => part.thought === true);
    expect(thoughtParts[0]?.text).toBe('想一想');

    expect(result.usage.promptTokens).toBe(120);
    expect(result.usage.completionTokens).toBe(9);
    expect(result.usage.totalTokens).toBe(129);
    expect(result.usage.cacheReadTokens).toBe(64);
  });

  it('reports usage in the trailing chunk and a gemini finishReason', async () => {
    const lines: string[] = [];
    await relayOpenAiChatSseToGeminiSse({
      reader: readerFrom(upstreamFrames),
      modelName: 'qwen3.8-flash',
      responseId: 'resp_test',
      write: (line) => lines.push(line),
    });

    const chunks = parseChunks(lines);
    const terminal = chunks[chunks.length - 1];
    expect(terminal.candidates[0].finishReason).toBe('STOP');
    expect(terminal.usageMetadata).toEqual({
      promptTokenCount: 120,
      candidatesTokenCount: 9,
      totalTokenCount: 129,
      cachedContentTokenCount: 64,
    });
  });

  it('rebuilds streamed tool arguments into a whole functionCall part', async () => {
    const lines: string[] = [];
    await relayOpenAiChatSseToGeminiSse({
      reader: readerFrom([
        'data: {"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
        'data: {"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n',
        'data: {"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"广州\\"}"}}]}}]}\n\n',
        'data: {"id":"c2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
      modelName: 'qwen3.8-flash',
      responseId: 'resp_tool',
      write: (line) => lines.push(line),
    });

    const chunks = parseChunks(lines);
    const call = chunks
      .flatMap((chunk) => chunk.candidates?.[0]?.content?.parts ?? [])
      .find((part: Record<string, any>) => part.functionCall);
    expect(call?.functionCall).toEqual({
      id: 'call_1',
      name: 'get_weather',
      args: { city: '广州' },
    });
    // Gemini has no tool-specific finish reason: a functionCall part is reported with STOP.
    expect(chunks[chunks.length - 1].candidates[0].finishReason).toBe('STOP');
  });

  it('keeps the gemini-cli envelope when asked to wrap payloads', async () => {
    const lines: string[] = [];
    await relayOpenAiChatSseToGeminiSse({
      reader: readerFrom(['data: {"id":"c3","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']),
      modelName: 'm',
      responseId: 'resp_cli',
      write: (line) => lines.push(line),
      wrapResponsePayload: true,
    });
    const chunks = parseChunks(lines);
    expect(chunks.every((chunk) => typeof chunk.response === 'object')).toBe(true);
  });
});
