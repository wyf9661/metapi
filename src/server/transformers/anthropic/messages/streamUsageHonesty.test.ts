import { describe, expect, it } from 'vitest';
import { anthropicMessagesStream } from './streamBridge.js';
import {
  hasProxyUsagePayload,
  parseProxyUsage,
} from '../../../services/proxyUsageParser.js';

// A peer metapi used to receive `usage: {input_tokens: 0, output_tokens: 0}`
// from us when we simply had not learned the counts yet. It logged
// `[usage:upstream]` with 0/0, i.e. "accounted, for free", and the real cause
// (nobody sent usage) became invisible. Omit the counters instead so the peer
// records `unknown`.
describe('anthropic stream usage is never invented', () => {
  function collect(frames: Array<{ event: string; data: unknown }>) {
    const streamContext = anthropicMessagesStream.createContext('m');
    const claudeContext = anthropicMessagesStream.createDownstreamContext();
    const lines: string[] = [];
    for (const frame of frames) {
      const consumed = anthropicMessagesStream.consumeAnthropicSseEvent(
        { event: frame.event, data: JSON.stringify(frame.data) },
        streamContext,
        claudeContext,
        'm',
      );
      lines.push(...consumed.lines);
      lines.push(...anthropicMessagesStream.serializeEvent(
        anthropicMessagesStream.normalizeEvent(JSON.parse(JSON.stringify(frame.data)), streamContext, 'm'),
        streamContext,
        claudeContext,
      ));
    }
    return lines.join('');
  }

  it('omits input_tokens in a synthesized message_start when the count is unknown', () => {
    const out = collect([
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
    ]);
    expect(out).toContain('message_start');
    expect(out).not.toContain('"input_tokens":0');
  });

  it('passes real counters through untouched', () => {
    const out = collect([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 1234, output_tokens: 1 } } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 567 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    expect(out).toContain('"input_tokens":1234');
    expect(out).toContain('"output_tokens":567');
  });

  it('an upstream frame carrying only zeros still parses as a present-but-zero usage', () => {
    // The local parser must keep reporting the frame; the defect was ours
    // inventing zeros, not the parser accepting an explicit 0.
    const usage = parseProxyUsage({ type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } });
    expect(usage.totalTokens).toBe(0);
    expect(hasProxyUsagePayload({ type: 'message_start', message: { usage: {} } })).toBe(false);
  });
});
