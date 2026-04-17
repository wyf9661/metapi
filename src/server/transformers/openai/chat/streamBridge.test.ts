import { describe, expect, it } from 'vitest';

import { createClaudeDownstreamContext } from '../../shared/normalized.js';
import { openAiChatStream } from './streamBridge.js';

function parseSsePayloads(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .filter((line) => line.startsWith('data: ') && line.trim() !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe('openai chat stream bridge', () => {
  it('normalizes stream payloads with choice metadata', () => {
    const context = openAiChatStream.createContext('gpt-5');
    const normalized = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-stream-1',
      model: 'gpt-5',
      choices: [{
        index: 0,
        finish_reason: null,
        delta: {
          role: 'assistant',
          content: 'hello',
          reasoning_content: 'think',
        },
      }],
    }, context, 'gpt-5');

    expect(normalized).toMatchObject({
      choiceIndex: 0,
      role: 'assistant',
      contentDelta: 'hello',
      reasoningDelta: 'think',
    });
  });

  it('serializes stream events and done markers as openai chat chunks', () => {
    const context = openAiChatStream.createContext('gpt-5');
    const lines = openAiChatStream.serializeEvent({
      role: 'assistant',
      contentDelta: 'hello',
    } as any, context, createClaudeDownstreamContext());
    const doneLines = openAiChatStream.serializeDone(context, createClaudeDownstreamContext());

    const payloads = parseSsePayloads(lines);
    expect(payloads[0]).toMatchObject({
      model: 'gpt-5',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: 'hello',
        },
      }],
    });
    expect(doneLines.join('')).toContain('[DONE]');
  });

  it('round-trips tool-call deltas without flattening them into plain text', () => {
    const context = openAiChatStream.createContext('gpt-5');
    const normalized = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-stream-tool-1',
      model: 'gpt-5',
      choices: [{
        index: 0,
        finish_reason: null,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: '{"city":"Shanghai"}',
            },
          }],
        },
      }],
    }, context, 'gpt-5');

    expect(normalized).toMatchObject({
      choiceIndex: 0,
      choiceEvents: [{
        index: 0,
        role: 'assistant',
        toolCallDeltas: [{
          index: 0,
          id: 'call_1',
          name: 'lookup_weather',
          argumentsDelta: '{"city":"Shanghai"}',
        }],
      }],
    });

    const payloads = parseSsePayloads(
      openAiChatStream.serializeEvent(normalized, context, createClaudeDownstreamContext()),
    );

    expect(payloads[0]).toMatchObject({
      model: 'gpt-5',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: '{"city":"Shanghai"}',
            },
          }],
        },
        finish_reason: null,
      }],
    });
  });

  it('does not replay historical tool identity on later multi-choice argument deltas', () => {
    const context = openAiChatStream.createContext('gpt-5');

    const started = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-stream-multi-tool-1',
      model: 'gpt-5',
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: {
            role: 'assistant',
            content: 'choice-0',
          },
        },
        {
          index: 1,
          finish_reason: null,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: {
                name: 'lookup_weather',
              },
            }],
          },
        },
      ],
    }, context, 'gpt-5');

    openAiChatStream.serializeEvent(started, context, createClaudeDownstreamContext());

    const continued = openAiChatStream.normalizeEvent({
      id: 'chatcmpl-stream-multi-tool-1',
      model: 'gpt-5',
      choices: [
        {
          index: 1,
          finish_reason: null,
          delta: {
            tool_calls: [{
              index: 0,
              function: {
                arguments: '{"city":"Shanghai"}',
              },
            }],
          },
        },
      ],
    }, context, 'gpt-5');

    const payloads = parseSsePayloads(
      openAiChatStream.serializeEvent(continued, context, createClaudeDownstreamContext()),
    );
    const toolCall = ((((payloads[0] as any).choices[0] as any).delta.tool_calls[0]) as Record<string, unknown>);

    expect((payloads[0] as any).choices[0]).toMatchObject({
      index: 1,
      delta: {
        tool_calls: [{
          index: 0,
          function: {
            arguments: '{"city":"Shanghai"}',
          },
        }],
      },
      finish_reason: null,
    });
    expect(toolCall.id).toBeUndefined();
    expect(toolCall.type).toBeUndefined();
    expect((toolCall.function as Record<string, unknown>).name).toBeUndefined();
  });
});
