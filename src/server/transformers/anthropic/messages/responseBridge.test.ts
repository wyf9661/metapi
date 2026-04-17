import { describe, expect, it } from 'vitest';

import {
  anthropicMessagesResponseBridge,
  buildNormalizedFinalToAnthropicMessagesBody,
  normalizeAnthropicMessagesFinalToNormalized,
} from './responseBridge.js';
import { anthropicMessagesOutbound } from './outbound.js';
import { anthropicMessagesUsage } from './usage.js';

describe('anthropic messages response bridge', () => {
  it('normalizes native anthropic finals into normalized final responses', () => {
    const normalized = normalizeAnthropicMessagesFinalToNormalized({
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
    }, 'claude-test');

    expect(normalized).toMatchObject({
      id: 'msg_native_1',
      model: 'claude-test',
      content: 'done',
      reasoningContent: 'plan first',
    });
  });

  it('builds anthropic messages payloads from normalized final responses', () => {
    const upstreamPayload = {
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
    };

    const normalized = normalizeAnthropicMessagesFinalToNormalized(upstreamPayload, 'claude-test');
    const payload = buildNormalizedFinalToAnthropicMessagesBody(
      normalized,
      anthropicMessagesUsage.fromPayload(upstreamPayload),
    );

    expect(payload).toEqual({
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
    });
  });

  it('preserves responses output-item ordering when serializing to anthropic blocks', () => {
    const normalized = normalizeAnthropicMessagesFinalToNormalized({
      id: 'resp_order_1',
      object: 'response',
      model: 'gpt-5',
      status: 'completed',
      output: [
        {
          id: 'rs_reasoning_1',
          type: 'reasoning',
          encrypted_content: 'metapi:anthropic-signature:sig-resp-1',
          summary: [
            { type: 'summary_text', text: 'plan first' },
          ],
        },
        {
          id: 'fc_weather_1',
          type: 'function_call',
          call_id: 'call_weather_1',
          name: 'lookup_weather',
          arguments: '{"city":"Paris"}',
        },
        {
          id: 'msg_order_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'done' },
          ],
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 6,
      },
    }, 'gpt-5');

    const payload = buildNormalizedFinalToAnthropicMessagesBody(normalized, {
      promptTokens: 12,
      completionTokens: 6,
      totalTokens: 18,
    });

    expect(payload.content).toEqual([
      {
        type: 'thinking',
        thinking: 'plan first',
        signature: 'sig-resp-1',
      },
      {
        type: 'tool_use',
        id: 'call_weather_1',
        name: 'lookup_weather',
        input: { city: 'Paris' },
      },
      {
        type: 'text',
        text: 'done',
      },
    ]);
  });

  it('maps responses web_search_call items into anthropic server tool blocks', () => {
    const normalized = normalizeAnthropicMessagesFinalToNormalized({
      id: 'resp_search_1',
      object: 'response',
      model: 'gpt-5',
      status: 'completed',
      output: [
        {
          id: 'ws_1',
          type: 'web_search_call',
          status: 'completed',
          action: {
            query: 'weather in Paris',
          },
        },
        {
          id: 'msg_search_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'It is sunny.' },
          ],
        },
      ],
      usage: {
        input_tokens: 9,
        output_tokens: 4,
      },
    }, 'gpt-5');

    const payload = buildNormalizedFinalToAnthropicMessagesBody(normalized, {
      promptTokens: 9,
      completionTokens: 4,
      totalTokens: 13,
    });

    expect(payload.content).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_ws_1',
        name: 'web_search',
        input: {
          query: 'weather in Paris',
        },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_ws_1',
        content: [],
      },
      {
        type: 'text',
        text: 'It is sunny.',
      },
    ]);
  });

  it('keeps the outbound facade pointed at the response bridge object', () => {
    expect(anthropicMessagesOutbound).toBe(anthropicMessagesResponseBridge);
  });
});
