import { describe, expect, it } from 'vitest';

import {
  anthropicMessagesStream,
  consumeAnthropicSseEvent,
  serializeAnthropicUpstreamFinalAsStream,
} from './streamBridge.js';
import { normalizeAnthropicMessagesFinalToNormalized } from './responseBridge.js';

describe('anthropic messages stream bridge', () => {
  it('passes through recognized raw anthropic SSE events and marks completion on message_stop', () => {
    const streamContext = anthropicMessagesStream.createContext('claude-test');
    const downstreamContext = anthropicMessagesStream.createDownstreamContext();

    const result = consumeAnthropicSseEvent(
      {
        event: 'message_stop',
        data: JSON.stringify({ type: 'message_stop' }),
      },
      streamContext,
      downstreamContext,
      'claude-test',
    );

    expect(result.handled).toBe(true);
    expect(result.done).toBe(true);
    expect(result.lines.join('')).toContain('event: message_stop');
  });

  it('serializes normalized upstream finals back into anthropic SSE blocks', () => {
    const streamContext = anthropicMessagesStream.createContext('claude-test');
    const downstreamContext = anthropicMessagesStream.createDownstreamContext();

    const lines = serializeAnthropicUpstreamFinalAsStream(
      {
        id: 'msg_native_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [
          {
            type: 'thinking',
            thinking: 'plan first',
            signature: 'sig-native',
          },
          {
            type: 'text',
            text: 'done',
          },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 30,
        },
      },
      'claude-test',
      '',
      normalizeAnthropicMessagesFinalToNormalized,
      streamContext,
      downstreamContext,
    );

    const parsed = anthropicMessagesStream.pullSseEvents(lines.join(''));
    expect(parsed.events.some((event) => event.event === 'message_start')).toBe(true);
    expect(parsed.events.some((event) => event.event === 'message_stop')).toBe(true);
    expect(lines.join('')).toContain('sig-native');
  });

  it('preserves whitespace in anthropic streaming text and thinking deltas', () => {
    const streamContext = anthropicMessagesStream.createContext('claude-test');
    const downstreamContext = anthropicMessagesStream.createDownstreamContext();

    const textResult = consumeAnthropicSseEvent(
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: '  padded text  ',
          },
        }),
      },
      streamContext,
      downstreamContext,
      'claude-test',
    );
    const thinkingResult = consumeAnthropicSseEvent(
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'thinking_delta',
            thinking: '  padded thinking  ',
          },
        }),
      },
      streamContext,
      downstreamContext,
      'claude-test',
    );

    expect(textResult.lines.join('')).toContain('  padded text  ');
    expect(thinkingResult.lines.join('')).toContain('  padded thinking  ');
  });

  it('preserves partial_json spacing for streaming tool-call deltas', () => {
    const streamContext = anthropicMessagesStream.createContext('claude-test');
    const downstreamContext = anthropicMessagesStream.createDownstreamContext();

    const result = consumeAnthropicSseEvent(
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{ "city": "Paris" }',
          },
        }),
      },
      streamContext,
      downstreamContext,
      'claude-test',
    );

    expect(result.lines.join('')).toContain('partial_json":"{ \\"city\\": \\"Paris\\" }"');
  });

  it('preserves responses output-item ordering when streaming anthropic fallback blocks', () => {
    const streamContext = anthropicMessagesStream.createContext('claude-test');
    const downstreamContext = anthropicMessagesStream.createDownstreamContext();

    const lines = serializeAnthropicUpstreamFinalAsStream(
      {
        id: 'resp_stream_order_1',
        object: 'response',
        model: 'gpt-5',
        status: 'completed',
        output: [
          {
            id: 'rs_reasoning_stream_1',
            type: 'reasoning',
            encrypted_content: 'metapi:anthropic-signature:sig-stream-1',
            summary: [{ type: 'summary_text', text: 'plan first' }],
          },
          {
            id: 'fc_stream_1',
            type: 'function_call',
            call_id: 'call_stream_1',
            name: 'lookup_weather',
            arguments: '{"city":"Paris"}',
          },
          {
            id: 'msg_stream_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done' }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
        },
      },
      'gpt-5',
      '',
      normalizeAnthropicMessagesFinalToNormalized,
      streamContext,
      downstreamContext,
    );

    const serialized = lines.join('');
    expect(serialized.indexOf('"type":"thinking"')).toBeGreaterThan(-1);
    expect(serialized.indexOf('"type":"tool_use"')).toBeGreaterThan(serialized.indexOf('"type":"thinking"'));
    expect(serialized.indexOf('"text":"done"')).toBeGreaterThan(serialized.indexOf('"type":"tool_use"'));
    expect(serialized).toContain('"signature":"sig-stream-1"');
  });

  it('serializes responses web_search_call items into anthropic server tool stream blocks', () => {
    const streamContext = anthropicMessagesStream.createContext('claude-test');
    const downstreamContext = anthropicMessagesStream.createDownstreamContext();

    const lines = serializeAnthropicUpstreamFinalAsStream(
      {
        id: 'resp_stream_search_1',
        object: 'response',
        model: 'gpt-5',
        status: 'completed',
        output: [
          {
            id: 'ws_stream_1',
            type: 'web_search_call',
            status: 'completed',
            action: {
              query: 'weather in Paris',
            },
          },
          {
            id: 'msg_stream_search_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'It is sunny.' }],
          },
        ],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
        },
      },
      'gpt-5',
      '',
      normalizeAnthropicMessagesFinalToNormalized,
      streamContext,
      downstreamContext,
    );

    const serialized = lines.join('');
    expect(serialized).toContain('"type":"server_tool_use"');
    expect(serialized).toContain('"name":"web_search"');
    expect(serialized).toContain('"type":"web_search_tool_result"');
    expect(serialized).toContain('"tool_use_id":"srvtoolu_ws_stream_1"');
    expect(serialized.indexOf('"type":"web_search_tool_result"')).toBeGreaterThan(serialized.indexOf('"type":"server_tool_use"'));
    expect(serialized).toContain('"text":"It is sunny."');
  });
});
