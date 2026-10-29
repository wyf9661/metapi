import { describe, expect, it } from 'vitest';

import {
  isErrorFinish,
  normalizeFinishReason,
  toAnthropicStopReason,
  toGeminiFinishReason,
  toOpenAiFinishReason,
} from './finishReason.js';
import { createStreamTransformContext, normalizeUpstreamStreamEvent } from './chatFormatsCore.js';
import { anthropicMessagesStream } from '../anthropic/messages/streamBridge.js';

describe('canonical finish reasons', () => {
  it('keeps a safety stop out of the clean-finish bucket', () => {
    // Regression: content_filter/safety/refusal used to match nothing and fell through to
    // `|| 'stop'`, so a blocked generation looked like a clean finish to billing and clients.
    for (const raw of ['content_filter', 'safety', 'SAFETY', 'recitation', 'blocklist',
      'prohibited_content', 'spii', 'image_safety', 'refusal', 'content-filter']) {
      expect(normalizeFinishReason(raw)).toBe('content_filter');
    }
  });

  it('maps failures to error rather than stop', () => {
    for (const raw of ['failed', 'error', 'cancelled', 'canceled', 'aborted', 'timeout',
      'server_error', 'malformed_function_call', 'unexpected_tool_call']) {
      expect(normalizeFinishReason(raw)).toBe('error');
    }
    expect(isErrorFinish('failed')).toBe(true);
    expect(isErrorFinish('stop')).toBe(false);
  });

  it('does not fuzzy-match substrings (the old includes() heuristics)', () => {
    // `includes('tool')` used to turn these into tool_calls, `includes('max')` into length.
    expect(normalizeFinishReason('nomatch')).toBeNull();
    expect(normalizeFinishReason('max_tool_calls')).toBeNull();
    expect(normalizeFinishReason('not_a_reason')).toBeNull();
    expect(normalizeFinishReason('')).toBeNull();
    expect(normalizeFinishReason(null)).toBeNull();
    expect(normalizeFinishReason(42)).toBeNull();
  });

  it('normalizes provider-specific spellings', () => {
    expect(normalizeFinishReason('end_turn')).toBe('stop');
    expect(normalizeFinishReason('stop_sequence')).toBe('stop');
    expect(normalizeFinishReason('pause_turn')).toBe('stop');
    expect(normalizeFinishReason('completed')).toBe('stop');
    expect(normalizeFinishReason('MAX_TOKENS')).toBe('length');
    expect(normalizeFinishReason('max_output_tokens')).toBe('length');
    expect(normalizeFinishReason('incomplete')).toBe('length');
    expect(normalizeFinishReason('tool_use')).toBe('tool_calls');
    expect(normalizeFinishReason('function_call')).toBe('tool_calls');
  });
});

describe('finish reason projections', () => {
  it('projects to the OpenAI enum', () => {
    expect(toOpenAiFinishReason('content_filter')).toBe('content_filter');
    expect(toOpenAiFinishReason('refusal')).toBe('content_filter');
    expect(toOpenAiFinishReason('max_tokens')).toBe('length');
    expect(toOpenAiFinishReason('tool_use')).toBe('tool_calls');
    expect(toOpenAiFinishReason('end_turn')).toBe('stop');
    // OpenAI has no error member: the wire value stays well-formed, the caller must emit
    // an SSE error frame instead.
    expect(toOpenAiFinishReason('failed')).toBe('stop');
  });

  it('projects to the Anthropic enum', () => {
    expect(toAnthropicStopReason('content_filter')).toBe('refusal');
    expect(toAnthropicStopReason('safety')).toBe('refusal');
    expect(toAnthropicStopReason('max_tokens')).toBe('max_tokens');
    expect(toAnthropicStopReason('tool_use')).toBe('tool_use');
    expect(toAnthropicStopReason('stop')).toBe('end_turn');
  });

  it('projects to the Gemini enum', () => {
    expect(toGeminiFinishReason('content_filter')).toBe('SAFETY');
    expect(toGeminiFinishReason('max_tokens')).toBe('MAX_TOKENS');
    expect(toGeminiFinishReason('failed')).toBe('OTHER');
    expect(toGeminiFinishReason('stop')).toBe('STOP');
  });
});

describe('finish reason through the stream normalizer', () => {
  it('carries a safety stop through an OpenAI chat chunk', () => {
    const context = createStreamTransformContext('m');
    const event = normalizeUpstreamStreamEvent(
      { choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] },
      context,
      'm',
    );
    expect(event.finishReason).toBe('content_filter');
  });

  it('carries a Gemini SAFETY candidate through', () => {
    const context = createStreamTransformContext('m');
    const event = normalizeUpstreamStreamEvent(
      { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'SAFETY' }] },
      context,
      'm',
    );
    expect(event.finishReason).toBe('content_filter');
  });

  it('carries a failed Responses status through as error', () => {
    const context = createStreamTransformContext('m');
    const event = normalizeUpstreamStreamEvent(
      { type: 'response.failed', response: { status: 'failed' } },
      context,
      'm',
    );
    expect(event.finishReason).toBe('error');
  });
});

describe('anthropic exit surfaces a failed stream', () => {
  it('emits an error event before message_delta instead of a clean end_turn', () => {
    const streamContext = anthropicMessagesStream.createContext('claude-test');
    const downstreamContext = anthropicMessagesStream.createDownstreamContext();

    const lines = anthropicMessagesStream.serializeEvent(
      { finishReason: 'error', done: true },
      streamContext,
      downstreamContext,
    );
    const text = lines.join('');

    expect(text).toContain('event: error');
    expect(text).toContain('"type":"api_error"');
    expect(text.indexOf('event: error')).toBeLessThan(text.indexOf('event: message_delta'));
  });

  it('reports a safety stop as refusal, not end_turn', () => {
    const streamContext = anthropicMessagesStream.createContext('claude-test');
    const downstreamContext = anthropicMessagesStream.createDownstreamContext();

    const text = anthropicMessagesStream
      .serializeEvent({ finishReason: 'content_filter', done: true }, streamContext, downstreamContext)
      .join('');

    expect(text).toContain('"stop_reason":"refusal"');
    expect(text).not.toContain('event: error');
  });
});
