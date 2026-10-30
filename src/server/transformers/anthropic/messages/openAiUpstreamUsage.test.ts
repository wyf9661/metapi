import { describe, expect, it } from 'vitest';
import { anthropicMessagesStream } from './streamBridge.js';
import { parseProxyUsage } from '../../../services/proxyUsageParser.js';

// Regression: an OpenAI-compatible upstream (every `new-api` relay) reports usage in a
// trailing chunk whose `choices` array is empty, *after* the finish_reason chunk. The
// generic stream normalizer used to drop that payload entirely, so Anthropic downstreams
// saw `message_start.usage: {}` plus a `message_delta` without usage and logged 0 tokens.
describe('openai upstream usage reaches an anthropic downstream stream', () => {
  function run(frames: unknown[]): { text: string; events: Array<{ event: string; data: any }> } {
    const streamContext = anthropicMessagesStream.createContext('m');
    const claudeContext = anthropicMessagesStream.createDownstreamContext();
    const lines: string[] = [];
    for (const frame of frames) {
      const normalized = anthropicMessagesStream.normalizeEvent(
        JSON.parse(JSON.stringify(frame)),
        streamContext,
        'm',
      );
      lines.push(...anthropicMessagesStream.serializeEvent(normalized, streamContext, claudeContext));
    }
    lines.push(...anthropicMessagesStream.serializeDone(streamContext, claudeContext));
    return {
      text: lines.join(''),
      events: anthropicMessagesStream.pullSseEvents(lines.join('')).events.map((item) => ({
        event: item.event,
        data: JSON.parse(item.data),
      })),
    };
  }

  const upstreamFrames = [
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '你好' } }] },
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      choices: [],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 42,
        total_tokens: 1242,
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    },
  ];

  it('holds message_delta until the usage chunk, then reports real counters', () => {
    const { events, text } = run(upstreamFrames);

    const delta = events.find((item) => item.event === 'message_delta');
    expect(delta?.data.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 42,
      cache_read_input_tokens: 1024,
    });
    // message_stop must be the very last frame.
    expect(events[events.length - 1]?.event).toBe('message_stop');

    // What the peer metapi would parse out of our stream.
    const parsed = parseProxyUsage(delta?.data);
    expect(parsed.promptTokens).toBe(1200);
    expect(parsed.completionTokens).toBe(42);
    expect(parsed.totalTokens).toBe(1242);

    expect(text).toContain('"stop_reason":"end_turn"');
  });

  it('does not terminate on finish_reason when no usage chunk ever arrives', () => {
    const { events } = run([
      { id: 'c', choices: [{ index: 0, delta: { content: 'hi' } }] },
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
    // The terminal pair is flushed by serializeDone (EOF/[DONE]) instead of vanishing.
    expect(events[events.length - 1]?.event).toBe('message_stop');
    expect(events.find((item) => item.event === 'message_delta')?.data.usage).toBeUndefined();
  });
});
