import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { DoneHubAdapter } from './doneHub.js';

describe('DoneHubAdapter', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/v1/models') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
        return;
      }

      if (req.url === '/api/available_model') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          'gpt-4o': { price: { input: 0.5, output: 1.5 } },
          'deepseek-chat': { price: { input: 0.1, output: 0.2 } },
        }));
        return;
      }

      if (req.url?.startsWith('/api/token/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            data: [
              { key: 'donehub-token-key', name: 'sys_playground', status: 1 },
            ],
          },
        }));
        return;
      }

      if (req.url === '/api/user/self') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: {
            quota: 20_000_000,
            used_quota: 30_000_000,
          },
        }));
        return;
      }

      if (req.url === '/api/notice') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: 'Scheduled maintenance tonight',
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  });

  it('marks checkin as unsupported', async () => {
    const adapter = new DoneHubAdapter();
    const result = await adapter.checkin(baseUrl, 'token');
    expect(result.success).toBe(false);
    expect(result.message).toBe('checkin endpoint not found');
  });

  it('falls back to /api/available_model when /v1/models is unavailable', async () => {
    const adapter = new DoneHubAdapter();
    const models = await adapter.getModels(baseUrl, 'token');
    expect(models).toEqual(['gpt-4o', 'deepseek-chat']);
  });

  it('parses token list from nested data.data shape', async () => {
    const adapter = new DoneHubAdapter();
    const tokens = await adapter.getApiTokens(baseUrl, 'token');
    expect(tokens).toEqual([
      { key: 'donehub-token-key', name: 'sys_playground', enabled: true },
    ]);
  });

  it('treats quota as remaining balance and sums used quota for total', async () => {
    const adapter = new DoneHubAdapter();
    const balance = await adapter.getBalance(baseUrl, 'token');
    expect(balance.balance).toBe(40);
    expect(balance.used).toBe(60);
    expect(balance.quota).toBe(100);
  });

  it('normalizes the global site notice from /api/notice', async () => {
    const adapter = new DoneHubAdapter();
    const rows = await adapter.getSiteAnnouncements(baseUrl, 'token');

    expect(rows).toEqual([
      {
        sourceKey: `notice:${createHash('sha1').update('Scheduled maintenance tonight').digest('hex')}`,
        title: 'Site notice',
        content: 'Scheduled maintenance tonight',
        level: 'info',
        sourceUrl: '/api/notice',
        rawPayload: { success: true, data: 'Scheduled maintenance tonight' },
      },
    ]);
  });
});
