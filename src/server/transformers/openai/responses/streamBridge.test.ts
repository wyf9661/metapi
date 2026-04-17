import { describe, expect, it } from 'vitest';

import {
  openAiResponsesStream,
  preserveMeaningfulResponsesTerminalPayload,
  serializeResponsesUpstreamFinalAsStream,
} from './streamBridge.js';

function parseSseEvents(lines: string[]): Array<{ event: string | null; payload: Record<string, unknown> | '[DONE]' }> {
  return lines
    .flatMap((line) => line.split('\n\n').filter((block) => block.trim().length > 0))
    .map((block) => {
      const eventLine = block
        .split('\n')
        .find((line) => line.startsWith('event: '));
      const dataLine = block
        .split('\n')
        .find((line) => line.startsWith('data: '));
      if (!dataLine) return null;
      if (dataLine === 'data: [DONE]') {
        return {
          event: eventLine ? eventLine.slice('event: '.length) : null,
          payload: '[DONE]' as const,
        };
      }

      return {
        event: eventLine ? eventLine.slice('event: '.length) : null,
        payload: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
      };
    })
    .filter((item): item is { event: string | null; payload: Record<string, unknown> | '[DONE]' } => !!item);
}

describe('openai responses stream bridge', () => {
  it('normalizes response stream payload metadata onto normalized events', () => {
    const context = openAiResponsesStream.createContext('gpt-5');
    const payload = {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
      },
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
      },
    };

    const normalized = openAiResponsesStream.normalizeEvent(payload, context, 'gpt-5');

    expect(normalized.responsesEventType).toBe('response.completed');
    expect(normalized.responsesPayload).toEqual(payload);
    expect(normalized.usagePayload).toEqual(payload.usage);
  });

  it('pulls response SSE events and preserves the DONE terminator', () => {
    const parsed = openAiResponsesStream.pullSseEvents([
      'event: response.completed',
      'data: {"type":"response.completed"}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'));

    expect(parsed.events).toEqual([
      {
        event: 'response.completed',
        data: '{"type":"response.completed"}',
      },
      {
        event: '',
        data: '[DONE]',
      },
    ]);
    expect(parsed.rest).toBe('');
  });

  it('serializes upstream final payloads into response.created and response.completed SSE lines', () => {
    const serialized = serializeResponsesUpstreamFinalAsStream({
      payload: {
        id: 'resp_fallback_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-5',
        output_text: 'hello from fallback',
        output: [
          {
            id: 'msg_fallback_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'hello from fallback' }],
          },
        ],
      },
      modelName: 'gpt-5',
      fallbackText: 'hello from fallback',
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });

    expect(serialized.isIncompletePayload).toBe(false);
    expect(serialized.lines.join('')).toContain('event: response.created');
    expect(serialized.lines.join('')).toContain('event: response.completed');
    expect(serialized.lines.join('')).toContain('"output_text":"hello from fallback"');
    expect(serialized.lines.join('')).toContain('data: [DONE]');
  });

  it('serializes fallback final tool and reasoning output items as canonical Responses SSE events before completion', () => {
    const serialized = serializeResponsesUpstreamFinalAsStream({
      payload: {
        id: 'resp_semantic_fallback_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-5',
        output_text: 'final answer',
        output: [
          {
            id: 'rs_1',
            type: 'reasoning',
            status: 'completed',
            summary: [{ type: 'summary_text', text: 'plan quietly' }],
          },
          {
            id: 'call_1',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_1',
            name: 'lookup_weather',
            arguments: '{"city":"Shanghai"}',
          },
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'final answer' }],
          },
        ],
      },
      modelName: 'gpt-5',
      fallbackText: 'final answer',
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });

    const events = parseSseEvents(serialized.lines);

    expect(events.map((entry) => entry.event)).toEqual([
      'response.created',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
      null,
    ]);
    expect(events[4]?.payload).toMatchObject({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'lookup_weather',
      arguments: '{"city":"Shanghai"}',
    });
    expect(events[9]?.payload).toMatchObject({
      type: 'response.completed',
      response: {
        id: 'resp_semantic_fallback_1',
        output_text: 'final answer',
        output: [
          {
            id: 'rs_1',
            type: 'reasoning',
          },
          {
            id: 'call_1',
            type: 'function_call',
            call_id: 'call_1',
            arguments: '{"city":"Shanghai"}',
          },
          {
            id: 'msg_1',
            type: 'message',
          },
        ],
      },
    });
    expect(events[10]?.payload).toBe('[DONE]');
  });

  it('preserves meaningful terminal response payload output when the synthesized terminal event is empty', () => {
    const preserved = preserveMeaningfulResponsesTerminalPayload(
      [
        'event: response.completed\n',
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_empty',
            status: 'completed',
            output: [],
            output_text: '',
          },
        })}\n\n`,
        'data: [DONE]\n\n',
      ],
      'response.completed',
      {
        type: 'response.completed',
        response: {
          id: 'resp_full',
          status: 'completed',
          output: [
            {
              id: 'msg_full',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'restored text' }],
            },
          ],
          output_text: 'restored text',
        },
      },
    );

    expect(preserved.join('')).toContain('"output_text":"restored text"');
    expect(preserved.join('')).toContain('data: [DONE]');
  });

  it('keeps response tool-call chains intact in completed SSE fallback payloads', () => {
    const serialized = serializeResponsesUpstreamFinalAsStream({
      payload: {
        id: 'resp_tool_stream_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-5',
        output_text: 'done',
        output: [
          {
            id: 'fc_1',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_1',
            name: 'lookup_weather',
            arguments: '{"city":"Shanghai"}',
          },
          {
            id: 'fco_1',
            type: 'function_call_output',
            status: 'completed',
            call_id: 'call_1',
            output: '22C',
          },
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done' }],
          },
        ],
      },
      modelName: 'gpt-5',
      fallbackText: 'done',
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });

    expect(serialized.lines.join('')).toContain('event: response.completed');
    expect(serialized.lines.join('')).toContain('"type":"function_call"');
    expect(serialized.lines.join('')).toContain('"type":"function_call_output"');
    expect(serialized.lines.join('')).toContain('"call_id":"call_1"');
    expect(serialized.lines.join('')).toContain('"output_text":"done"');
  });

  it('keeps incomplete fallback item statuses aligned with the terminal response status when item statuses are omitted', () => {
    const serialized = serializeResponsesUpstreamFinalAsStream({
      payload: {
        id: 'resp_incomplete_1',
        object: 'response',
        status: 'incomplete',
        model: 'gpt-5',
        output_text: 'partial',
        output: [
          {
            id: 'msg_partial_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'partial' }],
          },
        ],
      },
      modelName: 'gpt-5',
      fallbackText: 'partial',
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });

    const events = parseSseEvents(serialized.lines);

    expect(events.map((entry) => entry.event)).toEqual([
      'response.created',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.incomplete',
      null,
    ]);
    expect(events[3]?.payload).toMatchObject({
      type: 'response.output_item.done',
      item: {
        id: 'msg_partial_1',
        type: 'message',
        status: 'incomplete',
      },
    });
    expect(events[4]?.payload).toMatchObject({
      type: 'response.incomplete',
      response: {
        id: 'resp_incomplete_1',
        status: 'incomplete',
        output: [
          {
            id: 'msg_partial_1',
            type: 'message',
            status: 'incomplete',
          },
        ],
      },
    });
  });

  it('serializes failed fallback wrappers as response.failed and preserves the upstream error payload', () => {
    const serialized = serializeResponsesUpstreamFinalAsStream({
      payload: {
        type: 'response.failed',
        error: {
          message: 'upstream exploded',
          type: 'upstream_error',
        },
        response: {
          id: 'resp_failed_1',
          status: 'failed',
          model: 'gpt-5',
          output_text: 'partial',
          output: [
            {
              id: 'msg_failed_1',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'partial' }],
            },
          ],
        },
      },
      modelName: 'gpt-5',
      fallbackText: 'partial',
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });

    const events = parseSseEvents(serialized.lines);

    expect(events.map((entry) => entry.event)).toEqual([
      'response.created',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.failed',
      null,
    ]);
    expect(events[3]?.payload).toMatchObject({
      type: 'response.output_item.done',
      item: {
        id: 'msg_failed_1',
        type: 'message',
        status: 'failed',
      },
    });
    expect(events[4]?.payload).toMatchObject({
      type: 'response.failed',
      error: {
        message: 'upstream exploded',
        type: 'upstream_error',
      },
      response: {
        id: 'resp_failed_1',
        status: 'failed',
        output: [
          {
            id: 'msg_failed_1',
            type: 'message',
            status: 'failed',
          },
        ],
      },
    });
  });
});
