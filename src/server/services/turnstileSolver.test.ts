import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// settings 行由每个用例控制；其余 db 能力用不到，占位即可
// ---------------------------------------------------------------------------
let settingsRow: { key: string; value: string } | undefined;

vi.mock('../db/index.js', () => {
  const queryChain = {
    from: () => queryChain,
    where: () => queryChain,
    get: () => settingsRow,
  };
  return {
    db: {
      select: () => queryChain,
    },
    schema: {
      settings: { key: 'key', value: 'value' },
    },
  };
});

const {
  getTurnstileSolverSettings,
  isTurnstileRequiredMessage,
  solveTurnstileToken,
} = await import('./turnstileSolver.js');

const ENV_KEYS = ['TURNSTILE_SOLVER_URL', 'TURNSTILE_SOLVER_KEY', 'TURNSTILE_SOLVER_ENABLED'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  settingsRow = undefined;
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('isTurnstileRequiredMessage', () => {
  it('detects the new-api Turnstile gate messages', () => {
    expect(isTurnstileRequiredMessage('Turnstile token 为空')).toBe(true);
    expect(isTurnstileRequiredMessage('turnstile token is empty')).toBe(true);
    expect(isTurnstileRequiredMessage('站点开启了 Turnstile 校验，需要人工签到')).toBe(true);
    expect(isTurnstileRequiredMessage('Turnstile verification failed')).toBe(true);
  });

  it('ignores unrelated failure messages', () => {
    expect(isTurnstileRequiredMessage('今天已经签到过啦')).toBe(false);
    expect(isTurnstileRequiredMessage('Unauthorized, not logged in')).toBe(false);
    expect(isTurnstileRequiredMessage('')).toBe(false);
    expect(isTurnstileRequiredMessage(undefined)).toBe(false);
    expect(isTurnstileRequiredMessage(null)).toBe(false);
  });
});

describe('getTurnstileSolverSettings', () => {
  it('reads an enabled config from the settings row', async () => {
    settingsRow = {
      key: 'turnstile_solver_config',
      value: JSON.stringify({
        enabled: true,
        baseUrl: 'https://solver.example.com/',
        apiKey: 'sk-test',
        timeoutSeconds: 90,
      }),
    };
    const settings = await getTurnstileSolverSettings();
    expect(settings).toEqual({
      enabled: true,
      // trailing slash is stripped: `${baseUrl}/solve` would otherwise be `//solve`
      baseUrl: 'https://solver.example.com',
      apiKey: 'sk-test',
      timeoutSeconds: 90,
    });
  });

  it('clamps the timeout into a safe range and defaults to 60s', async () => {
    settingsRow = {
      key: 'turnstile_solver_config',
      value: JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:8199', apiKey: '' }),
    };
    const settings = await getTurnstileSolverSettings();
    expect(settings?.timeoutSeconds).toBe(60);

    settingsRow = {
      key: 'turnstile_solver_config',
      value: JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:8199', timeoutSeconds: 999 }),
    };
    expect((await getTurnstileSolverSettings())?.timeoutSeconds).toBe(180);

    settingsRow = {
      key: 'turnstile_solver_config',
      value: JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:8199', timeoutSeconds: 3 }),
    };
    expect((await getTurnstileSolverSettings())?.timeoutSeconds).toBe(15);
  });

  it('returns null when disabled, unconfigured or malformed', async () => {
    settingsRow = {
      key: 'turnstile_solver_config',
      value: JSON.stringify({ enabled: false, baseUrl: 'https://solver.example.com' }),
    };
    expect(await getTurnstileSolverSettings()).toBeNull();

    settingsRow = { key: 'turnstile_solver_config', value: JSON.stringify({ enabled: true }) };
    expect(await getTurnstileSolverSettings()).toBeNull();

    settingsRow = { key: 'turnstile_solver_config', value: '{not json' };
    expect(await getTurnstileSolverSettings()).toBeNull();

    settingsRow = undefined;
    expect(await getTurnstileSolverSettings()).toBeNull();
  });

  it('falls back to env vars when no settings row exists', async () => {
    process.env.TURNSTILE_SOLVER_URL = 'http://127.0.0.1:8199';
    process.env.TURNSTILE_SOLVER_KEY = 'env-key';
    const settings = await getTurnstileSolverSettings();
    expect(settings).toEqual({
      enabled: true,
      baseUrl: 'http://127.0.0.1:8199',
      apiKey: 'env-key',
      timeoutSeconds: 60,
    });

    process.env.TURNSTILE_SOLVER_ENABLED = 'false';
    expect(await getTurnstileSolverSettings()).toBeNull();
  });
});

describe('solveTurnstileToken', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let requests: { url: string; headers: IncomingMessage['headers'] }[] = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void;

  beforeEach(async () => {
    requests = [];
    handler = (req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    };
    server = createServer((req, res) => {
      requests.push({ url: req.url || '/', headers: req.headers });
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => handler(req, res));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const settings = () => ({
    enabled: true,
    baseUrl,
    apiKey: 'sk-test',
    timeoutSeconds: 15,
  });

  it('returns the token from the sync /solve endpoint and sends a browser UA', async () => {
    handler = (req, res) => {
      if (req.url === '/solve') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: 'sync-token', elapsed: 1.2, attempts: 1 }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const result = await solveTurnstileToken(settings(), {
      pageUrl: 'https://target.example/sign-in',
      sitekey: '0x4AAAAAAEM5z6JyQL_QS07g',
    });

    expect(result).toMatchObject({ success: true, token: 'sync-token' });
    const solveRequest = requests.find((r) => r.url === '/solve');
    expect(solveRequest).toBeTruthy();
    expect(String(solveRequest!.headers['user-agent'])).toContain('Mozilla/5.0');
    expect(solveRequest!.headers['x-api-key']).toBe('sk-test');
  });

  it('falls back to the async createTask/getTaskResult flow when /solve is unavailable', async () => {
    handler = (req, res) => {
      if (req.url === '/solve') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (req.url === '/createTask') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errorId: 0, taskId: 'task-1' }));
        return;
      }
      if (req.url === '/getTaskResult') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errorId: 0, status: 'ready', solution: { token: 'async-token' } }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const result = await solveTurnstileToken(settings(), {
      pageUrl: 'https://target.example/sign-in',
      sitekey: '0x4AAAAAAEM5z6JyQL_QS07g',
    });

    expect(result).toMatchObject({ success: true, token: 'async-token' });
    expect(requests.map((r) => r.url)).toContain('/createTask');
    expect(requests.map((r) => r.url)).toContain('/getTaskResult');
  }, 15000);

  it('falls back to the GET /turnstile → /result flow when neither /solve nor createTask exists', async () => {
    let polled = 0;
    handler = (req, res) => {
      if ((req.url || '').startsWith('/turnstile?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errorId: 0, taskId: 't-1' }));
        return;
      }
      if ((req.url || '').startsWith('/result?id=')) {
        polled += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(polled > 1
          ? { errorId: 0, solution: { token: 'task-result-token', userAgent: 'UA/1.0' } }
          : { errorId: 0, status: 'processing' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const result = await solveTurnstileToken(settings(), {
      pageUrl: 'https://target.example/sign-in',
      sitekey: '0x4AAAAAAEM5z6JyQL_QS07g',
    });

    expect(result).toMatchObject({ success: true, token: 'task-result-token', userAgent: 'UA/1.0' });
    const created = requests.find((r) => (r.url || '').startsWith('/turnstile?'));
    expect(created).toBeTruthy();
    expect(created!.headers['x-api-key']).toBe('sk-test');
    expect(decodeURIComponent(created!.url!)).toContain('url=https://target.example/sign-in');
  }, 20000);

  it('reports failure when every solving attempt fails', async () => {
    handler = (req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
    };

    const result = await solveTurnstileToken(settings(), {
      pageUrl: 'https://target.example/sign-in',
      sitekey: '0x4AAAAAAEM5z6JyQL_QS07g',
    });

    expect(result.success).toBe(false);
    expect(result.token).toBeUndefined();
  }, 15000);
});
