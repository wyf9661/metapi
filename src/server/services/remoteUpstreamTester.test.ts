import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));
import {
  buildRemoteAuthHeaders,
  buildRemoteProtocolBody,
  extractRemoteModelNames,
  normalizeRemoteBaseUrl,
  resolveRemoteModelsUrl,
  resolveRemoteProtocolUrl,
} from './remoteUpstreamTester.js';

describe('remoteUpstreamTester helpers', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
  });

  it('rejects private, ULA, unspecified and IPv4-mapped loopback destinations', async () => {
    for (const address of ['127.0.0.1', 'fd00::1', '::', '::ffff:127.0.0.1']) {
      lookupMock.mockResolvedValueOnce([{ address, family: address.includes(':') ? 6 : 4 }]);
      await expect(normalizeRemoteBaseUrl('https://blocked.example')).rejects.toThrow(/non-public IP/);
    }
  });

  it('normalizes pasted leaf endpoints back to an API root', async () => {
    await expect(normalizeRemoteBaseUrl('https://api.example.com/v1/models')).resolves.toBe('https://api.example.com');
    await expect(normalizeRemoteBaseUrl('https://api.example.com/v1/chat/completions')).resolves.toBe('https://api.example.com');
    await expect(normalizeRemoteBaseUrl('https://api.example.com/v1/messages')).resolves.toBe('https://api.example.com');
    await expect(normalizeRemoteBaseUrl('https://api.example.com/v1/responses')).resolves.toBe('https://api.example.com');
    await expect(normalizeRemoteBaseUrl('api.example.com/v1')).resolves.toBe('https://api.example.com/v1');
  });

  it('resolves models and protocol endpoints from base urls with or without /v1', async () => {
    await expect(resolveRemoteModelsUrl('https://api.example.com')).resolves.toBe('https://api.example.com/v1/models');
    await expect(resolveRemoteModelsUrl('https://api.example.com/v1')).resolves.toBe('https://api.example.com/v1/models');
    await expect(resolveRemoteProtocolUrl('https://api.example.com', 'completion')).resolves.toBe('https://api.example.com/v1/chat/completions');
    await expect(resolveRemoteProtocolUrl('https://api.example.com/v1', 'anthropic')).resolves.toBe('https://api.example.com/v1/messages');
    await expect(resolveRemoteProtocolUrl('https://api.example.com', 'responses')).resolves.toBe('https://api.example.com/v1/responses');
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
