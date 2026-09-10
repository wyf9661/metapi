import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MetApiAdapter } from './metapi.js';

const fetchMock = vi.fn();

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

describe('metapi platform adapter', () => {
  const adapter = new MetApiAdapter();

  beforeAll(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('detect() only claims metapi hostnames, never probes the network', async () => {
    expect(await adapter.detect('https://metapi.example.com')).toBe(true);
    expect(await adapter.detect('https://metapi.abc-tunnel.us/v1')).toBe(true);
    expect(await adapter.detect('https://api.example.com')).toBe(false);
    expect(await adapter.detect('https://www.mofas.one')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifyToken maps an admin token (peer overview 200) to session with metrics', async () => {
    fetchMock.mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (url.includes('/api/v1/peer/overview')) {
        return reply(200, {
          protocolVersion: 1,
          site: { totalBalance: 123.45, totalUsed: 76.5, activeAccounts: 4, totalAccounts: 6 },
          today: { spend: 3.25, reward: 1.5 },
          updatedAt: '2026-09-10T15:00:00.000Z',
        });
      }
      if (url.includes('/v1/models')) {
        return reply(200, { data: [{ id: 'glm-5' }, { id: 'deepseek-v4' }] });
      }
      return reply(404, {});
    });

    const result = await adapter.verifyToken('https://peer.example.com', 'admin-token-xyz');
    expect(result.tokenType).toBe('session');
    expect(result.balance).toEqual({
      balance: 123.45,
      used: 76.5,
      quota: 0,
      todayQuotaConsumption: 3.25,
      todayIncome: 1.5,
    });
    expect(result.models).toEqual(['glm-5', 'deepseek-v4']);
  });

  it('verifyToken maps a downstream sk- key (overview 401, models 200) to apikey with no metrics', async () => {
    fetchMock.mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (url.includes('/api/v1/peer/overview')) {
        return reply(401, { error: 'Invalid token' });
      }
      if (url.includes('/v1/models')) {
        return reply(200, { data: [{ id: 'glm-5' }] });
      }
      return reply(404, {});
    });

    const result = await adapter.verifyToken('https://peer.example.com', 'sk-peer-key');
    expect(result.tokenType).toBe('apikey');
    expect(result.balance).toBeUndefined();
    expect(result.models).toEqual(['glm-5']);
  });

  it('verifyToken returns unknown when both tracks fail', async () => {
    fetchMock.mockImplementation(async () => reply(401, { error: 'Invalid token' }));
    const result = await adapter.verifyToken('https://peer.example.com', 'nope');
    expect(result.tokenType).toBe('unknown');
  });

  it('getBalance throws a clear error when the credential is not an admin token', async () => {
    fetchMock.mockImplementation(async () => reply(401, { error: 'Invalid token' }));
    await expect(adapter.getBalance('https://peer.example.com', 'sk-peer-key'))
      .rejects.toThrow('admin token required');
  });

  it('getModels returns [] on transport failure (empty catalog contract)', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('network down'); });
    expect(await adapter.getModels('https://peer.example.com', 'sk-x')).toEqual([]);
  });

  it('getBalance normalizes /v1 base URLs before calling the overview endpoint', async () => {
    fetchMock.mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (url === 'https://peer.example.com/api/v1/peer/overview') {
        return reply(200, {
          protocolVersion: 1,
          site: { totalBalance: 10, totalUsed: 1, activeAccounts: 1, totalAccounts: 1 },
          today: { spend: 0.5, reward: 0 },
        });
      }
      return reply(404, {});
    });

    const balance = await adapter.getBalance('https://peer.example.com/v1', 'admin-token');
    expect(balance.balance).toBe(10);
    expect(balance.todayQuotaConsumption).toBe(0.5);
  });
});
