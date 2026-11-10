import { describe, expect, it } from 'vitest';
import {
  captureUpstreamResponseModel,
  getUpstreamResponseModel,
  readResponseModel,
} from './upstreamResponseModel.js';

describe('upstreamResponseModel', () => {
  it('reads the model from chat, Anthropic and Responses payloads', () => {
    expect(readResponseModel({ model: 'deepseek-v4.1-flash-1017' })).toBe('deepseek-v4.1-flash-1017');
    expect(readResponseModel({ type: 'message_start', message: { model: 'claude-opus-5-5' } }))
      .toBe('claude-opus-5-5');
    expect(readResponseModel({ type: 'response.created', response: { model: 'gpt-6.1-sol' } }))
      .toBe('gpt-6.1-sol');
    expect(readResponseModel({ modelVersion: 'gemini-3-pro' })).toBe('gemini-3-pro');
  });

  it('ignores payloads that carry no model', () => {
    expect(readResponseModel({ choices: [] })).toBeNull();
    expect(readResponseModel({ model: '   ' })).toBeNull();
    expect(readResponseModel('data: [DONE]')).toBeNull();
  });

  it('keeps the last model the upstream reported for this request', () => {
    captureUpstreamResponseModel({ model: 'deepseek-flash' });
    expect(getUpstreamResponseModel()).toBe('deepseek-flash');
    captureUpstreamResponseModel({ model: 'deepseek-v4.1-flash-1017' });
    expect(getUpstreamResponseModel()).toBe('deepseek-v4.1-flash-1017');
    // Chunks that do not repeat the model must not erase what already arrived.
    captureUpstreamResponseModel({ choices: [{ delta: {} }] });
    expect(getUpstreamResponseModel()).toBe('deepseek-v4.1-flash-1017');
  });
});