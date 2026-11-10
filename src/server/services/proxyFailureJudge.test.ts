import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { detectProxyFailure } from './proxyFailureJudge.js';

describe('detectProxyFailure (empty content)', () => {
  const originalEmptyFail = config.proxyEmptyContentFailEnabled;
  const originalKeywords = Array.isArray(config.proxyErrorKeywords) ? [...config.proxyErrorKeywords] : config.proxyErrorKeywords;

  afterEach(() => {
    config.proxyEmptyContentFailEnabled = originalEmptyFail;
    config.proxyErrorKeywords = originalKeywords as any;
  });

  it('flags empty assistant content even when total tokens > 0', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_empty',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 12, completionTokens: 0, totalTokens: 12 },
    });

    expect(failure).toMatchObject({ status: 502 });
  });

  it('does not flag when output exists even if usage is missing', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_has_output',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hi' },
        finish_reason: 'stop',
      }],
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toBeNull();
  });

  it('does not treat tool call payloads as empty content', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'resp_tool',
      object: 'response',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_abc',
        name: 'Glob',
        arguments: '{"pattern":"README*"}',
      }],
      output_text: '',
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toBeNull();
  });

  it('flags reasoning-only chat completions as empty content even with completion tokens', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_reasoning_only',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '', reasoning_content: 'thinking but never answering' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 32, total_tokens: 42 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 10, completionTokens: 32, totalTokens: 42 },
    });

    expect(failure).toMatchObject({ status: 502 });
    expect(failure?.reason).toContain('reasoning only');
  });

  it('flags reasoning-only SSE streams as empty content', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = [
      'data: {"id":"evt_1","choices":[{"delta":{"reasoning_content":"thinking"}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 15, totalTokens: 15 },
    });

    expect(failure).toMatchObject({ status: 502 });
    expect(failure?.reason).toContain('reasoning only');
  });

  it('still passes when reasoning is followed by visible content', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_reasoning_and_content',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'the answer', reasoning_content: 'thinking' },
        finish_reason: 'stop',
      }],
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toBeNull();
  });

  it('flags empty SSE streams that contain no content deltas', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = [
      'data: {"id":"evt_1","choices":[{"delta":{}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toMatchObject({ status: 502 });
  });

  it('treats DONE-only SSE as no output and flags failure', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = [
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toMatchObject({ status: 502 });
  });

  it('truncates fractional token counts before empty-content detection', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_fractional_empty',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 3.9, completion_tokens: 0.6, total_tokens: 4.5 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 3.9, completionTokens: 0.6, totalTokens: 4.5 } as any,
    });

    expect(failure).toMatchObject({ status: 502 });
  });

  it('does not flag empty content when the downstream client already aborted', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_empty',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });

    // A client Ctrl+C / cancel leaves an empty upstream outcome that is the
    // cancel itself, not an upstream defect: the empty-content heuristic must
    // stay silent so the channel is not failed over / health-degraded.
    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      downstreamAborted: true,
    });

    expect(failure).toBeNull();
  });

  it('still flags empty content when downstream is alive (upstream swallow)', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_empty',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      downstreamAborted: false,
    });

    expect(failure).toMatchObject({ status: 502 });
  });
});

describe('detectProxyFailure (malformed tool call arguments)', () => {
  const originalEmptyFail = config.proxyEmptyContentFailEnabled;

  afterEach(() => {
    config.proxyEmptyContentFailEnabled = originalEmptyFail;
  });

  it('flags a non-stream body whose tool call arguments are half JSON', () => {
    config.proxyEmptyContentFailEnabled = true;
    const rawText = JSON.stringify({
      id: 'chatcmpl_malformed',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: '{"comm' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
    });

    expect(detectProxyFailure({ rawText, usage: { completionTokens: 8 } })).toMatchObject({
      status: 502,
      reason: 'Upstream returned malformed tool call arguments',
    });
  });

  it('passes SSE streams whose argument fragments reassemble by index', () => {
    config.proxyEmptyContentFailEnabled = true;
    const frame1 = JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'terminal', arguments: '{"command"' } }] } }] });
    const frame2 = JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }, finish_reason: 'tool_calls' }] });
    const rawText = [`data: ${frame1}`, '', `data: ${frame2}`, '', 'data: [DONE]', ''].join('\n');

    expect(detectProxyFailure({ rawText, usage: { completionTokens: 12 } })).toBeNull();
  });
});
