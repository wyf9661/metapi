import { describe, expect, it } from 'vitest';
import {
  buildRemoteAuthHeaders,
  buildRemoteProtocolBody,
  extractRemoteModelNames,
  normalizeRemoteBaseUrl,
  resolveRemoteModelsUrl,
  resolveRemoteProtocolUrl,
} from './remoteUpstreamTester.js';

describe('remoteUpstreamTester helpers', () => {
  it('normalizes pasted leaf endpoints back to an API root', () => {
    expect(normalizeRemoteBaseUrl('https://api.example.com/v1/models')).toBe('https://api.example.com');
    expect(normalizeRemoteBaseUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com');
    expect(normalizeRemoteBaseUrl('https://api.example.com/v1/messages')).toBe('https://api.example.com');
    expect(normalizeRemoteBaseUrl('https://api.example.com/v1/responses')).toBe('https://api.example.com');
    expect(normalizeRemoteBaseUrl('api.example.com/v1')).toBe('https://api.example.com/v1');
  });

  it('resolves models and protocol endpoints from base urls with or without /v1', () => {
    expect(resolveRemoteModelsUrl('https://api.example.com')).toBe('https://api.example.com/v1/models');
    expect(resolveRemoteModelsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models');
    expect(resolveRemoteProtocolUrl('https://api.example.com', 'completion')).toBe('https://api.example.com/v1/chat/completions');
    expect(resolveRemoteProtocolUrl('https://api.example.com/v1', 'anthropic')).toBe('https://api.example.com/v1/messages');
    expect(resolveRemoteProtocolUrl('https://api.example.com', 'responses')).toBe('https://api.example.com/v1/responses');
  });

  it('builds auth headers and minimal probe bodies per protocol', () => {
    expect(buildRemoteAuthHeaders('sk-test', 'completion')).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    });
    expect(buildRemoteAuthHeaders('sk-test', 'anthropic')).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'sk-test',
      'anthropic-version': '2023-06-01',
    });

    expect(buildRemoteProtocolBody('completion', 'gpt-4o-mini', 'hi', 8)).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      stream: false,
    });
    expect(buildRemoteProtocolBody('anthropic', 'claude-3-5-sonnet', 'hi', 8)).toEqual({
      model: 'claude-3-5-sonnet',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    expect(buildRemoteProtocolBody('responses', 'gpt-5', 'hi', 8)).toEqual({
      model: 'gpt-5',
      input: 'hi',
      max_output_tokens: 8,
      stream: false,
    });
  });

  it('extracts model ids from common list payloads', () => {
    expect(extractRemoteModelNames({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] })).toEqual(['a', 'b']);
    expect(extractRemoteModelNames({ models: ['x', 'y'] })).toEqual(['x', 'y']);
    expect(extractRemoteModelNames([{ name: 'n1' }, { model: 'n2' }])).toEqual(['n1', 'n2']);
  });
});
