import { describe, expect, it } from 'vitest';

import {
  consumeUpstreamSseBuffer,
  geminiGenerateContentStream,
  parseGeminiStreamPayload,
  serializeAggregateSsePayload,
} from './streamBridge.js';

describe('gemini generate-content stream bridge', () => {
  it('parses SSE payloads and preserves trailing rest blocks', () => {
    const parsed = parseGeminiStreamPayload([
      'data: {"responseId":"resp-1","candidates":[{"content":{"parts":[{"text":"hello"}]}}]}',
      '',
      'data: [DONE]',
      '',
      'data: {"responseId":"partial"',
    ].join('\n'), 'text/event-stream');

    expect(parsed.format).toBe('sse');
    expect(parsed.events).toHaveLength(1);
    expect(parsed.rest).toBe('data: {"responseId":"partial"');
  });

  it('aggregates upstream SSE blocks while preserving raw lines and serializable final output', () => {
    const state = geminiGenerateContentStream.createAggregateState();
    const result = consumeUpstreamSseBuffer(state, [
      'data: {"responseId":"resp-1","candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'));

    expect(result.lines).toHaveLength(2);
    expect(result.events).toHaveLength(1);
    expect(result.rest).toBe('');
    expect(serializeAggregateSsePayload(result.state)).toContain('"responseId":"resp-1"');
  });
});
