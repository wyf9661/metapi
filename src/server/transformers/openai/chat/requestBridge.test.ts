import { describe, expect, it } from 'vitest';

import {
  buildCanonicalRequestToOpenAiChatBody,
  parseOpenAiChatRequestToCanonical,
} from './requestBridge.js';

describe('openai chat request bridge', () => {
  it('parses OpenAI Chat bodies into canonical envelopes', () => {
    const result = parseOpenAiChatRequestToCanonical({
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
      prompt_cache_key: 'cache-key',
      reasoning_effort: 'high',
      reasoning_budget: 1024,
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      operation: 'generate',
      surface: 'openai-chat',
      requestedModel: 'gpt-5',
      continuation: {
        promptCacheKey: 'cache-key',
      },
      reasoning: {
        effort: 'high',
        budgetTokens: 1024,
      },
    });
  });

  it('builds OpenAI Chat bodies from canonical envelopes', () => {
    const body = buildCanonicalRequestToOpenAiChatBody({
      operation: 'generate',
      surface: 'openai-chat',
      cliProfile: 'codex',
      requestedModel: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      reasoning: {
        effort: 'medium',
        budgetTokens: 512,
      },
      continuation: {
        promptCacheKey: 'cache-key',
      },
    });

    expect(body).toMatchObject({
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
      prompt_cache_key: 'cache-key',
      reasoning_effort: 'medium',
      reasoning_budget: 512,
    });
  });

  it('preserves assistant reasoning history alongside tool calls when parsing chat requests', () => {
    const result = parseOpenAiChatRequestToCanonical({
      model: 'gpt-5',
      stream: false,
      messages: [
        {
          role: 'assistant',
          content: '',
          reasoning_content: 'plan quietly',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'Glob',
              arguments: '{"pattern":"README*"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'README.md',
        },
      ],
    });

    expect(result.error).toBeUndefined();
    expect(result.value?.messages).toEqual([
      {
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: 'plan quietly',
            thought: true,
          },
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'Glob',
            argumentsJson: '{"pattern":"README*"}',
          },
        ],
      },
      {
        role: 'tool',
        parts: [{
          type: 'tool_result',
          toolCallId: 'call_1',
          resultText: 'README.md',
        }],
      },
    ]);
  });
});
