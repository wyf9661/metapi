import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDesktopServerEnv,
  createDesktopServerUrl,
  isFatalServerExit,
  parseDotEnvFile,
  resolveDesktopServerPort,
  resolveDesktopServerPortAsync,
  resolveDesktopServerWorkingDir,
  waitForServerReady,
} from './runtime.js';

describe('desktop runtime helpers', () => {
  it('builds desktop server env with external listen host and app directories', () => {
    const env = buildDesktopServerEnv({
      inheritedEnv: {
        AUTH_TOKEN: 'admin-token',
        PROXY_TOKEN: 'proxy-token',
      },
      userDataDir: '/tmp/metapi-data',
      logsDir: '/tmp/metapi-logs',
      port: 4312,
    });

    expect(env.HOST).toBe('0.0.0.0');
    expect(env.PORT).toBe('4312');
    expect(env.DATA_DIR).toBe('/tmp/metapi-data');
    expect(env.METAPI_LOG_DIR).toBe('/tmp/metapi-logs');
    expect(env.AUTH_TOKEN).toBe('admin-token');
    expect(env.PROXY_TOKEN).toBe('proxy-token');
  });

  it('injects strong random auth token + credential secret when secrets are missing', () => {
    const env = buildDesktopServerEnv({
      inheritedEnv: {},
      userDataDir: '/tmp/metapi-data',
      logsDir: '/tmp/metapi-logs',
      port: 4312,
    });

    expect(env.AUTH_TOKEN).toBeDefined();
    expect(env.AUTH_TOKEN).toMatch(/^[\w-]{24,}$/);
    expect(env.ACCOUNT_CREDENTIAL_SECRET).toBeDefined();
    expect(env.ACCOUNT_CREDENTIAL_SECRET).not.toBe(env.AUTH_TOKEN);
  });

  it('keeps persisted ACCOUNT_CREDENTIAL_SECRET stable across launches', () => {
    const inherited = {
      AUTH_TOKEN: 'change-me-admin-token',
      ACCOUNT_CREDENTIAL_SECRET: 'my-persisted-account-secret-32ch',
    };
    const env = buildDesktopServerEnv({
      inheritedEnv: { ...inherited },
      userDataDir: '/tmp/metapi-data',
      logsDir: '/tmp/metapi-logs',
      port: 4312,
    });

    // AUTH_TOKEN is still the default → replaced with random.
    expect(env.AUTH_TOKEN).not.toBe('change-me-admin-token');
    // ACCOUNT_CREDENTIAL_SECRET is a real non-default value → must be kept.
    expect(env.ACCOUNT_CREDENTIAL_SECRET).toBe('my-persisted-account-secret-32ch');
  });

  it('creates the browser URL from the local desktop port', () => {
    expect(createDesktopServerUrl(4312)).toBe('http://127.0.0.1:4312');
  });

  it('defaults desktop backend port to 4000', () => {
    expect(resolveDesktopServerPort({})).toBe(4000);
  });

  it('honors explicit desktop backend port override', () => {
    expect(resolveDesktopServerPort({
      METAPI_DESKTOP_SERVER_PORT: '4312',
    })).toBe(4312);
  });

  it('honors explicit desktop backend port override in async resolver', async () => {
    expect(await resolveDesktopServerPortAsync({
      METAPI_DESKTOP_SERVER_PORT: '4312',
    })).toBe(4312);
  });

  it('async resolver prefers 4000 and falls back to an available port when busy', async () => {
    // get-port: preferred port when free, next available when taken.
    // 4000 is currently occupied on this machine (local agent), so the async
    // resolver must return something usable and different from 4000.
    const resolved = await resolveDesktopServerPortAsync({});
    expect(Number.isInteger(resolved)).toBe(true);
    expect(resolved).toBeGreaterThan(0);
    // Must not silently pick a port the user explicitly asked for elsewhere.
    expect(resolved).not.toBeNaN();
  });

  it('parses dotenv-style lines with comments, quotes and blank lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metapi-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, [
      '# comment line',
      '',
      'MODEL_AVAILABILITY_PROBE_TIMEOUT_MS=45000',
      'PROBE_HEARTBEAT_TIMEOUT_MS="60000"',
      'TZ=Asia/Shanghai',
      'AUTH_TOKEN="quoted-token"',
      'INVALID LINE NO EQUALS',
      '=no-key',
      'DATA_DIR=',
    ].join('\n'), 'utf8');

    const parsed = parseDotEnvFile(file);
    expect(parsed.get('MODEL_AVAILABILITY_PROBE_TIMEOUT_MS')).toBe('45000');
    expect(parsed.get('PROBE_HEARTBEAT_TIMEOUT_MS')).toBe('60000');
    expect(parsed.get('TZ')).toBe('Asia/Shanghai');
    expect(parsed.get('AUTH_TOKEN')).toBe('quoted-token');
    expect(parsed.has('INVALID LINE NO EQUALS')).toBe(false);
    expect(parsed.has('=no-key')).toBe(false);
    expect(parsed.get('DATA_DIR')).toBe('');
  });

  it('returns an empty map for a missing .env file', () => {
    expect(parseDotEnvFile(join(tmpdir(), 'metapi-env-missing-' + Date.now(), '.env')).size).toBe(0);
  });

  it('loads user .env over inherited env and keeps forced desktop overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metapi-env-'));
    writeFileSync(join(dir, '.env'), [
      'MODEL_AVAILABILITY_PROBE_TIMEOUT_MS=45000',
      'PORT=9999',
      'AUTH_TOKEN=from-user-env',
    ].join('\n'), 'utf8');

    const env = buildDesktopServerEnv({
      inheritedEnv: {
        MODEL_AVAILABILITY_PROBE_TIMEOUT_MS: '30000',
        AUTH_TOKEN: 'change-me-admin-token',
      },
      userDataDir: dir,
      logsDir: join(dir, 'logs'),
      port: 4312,
    });

    // User .env wins over inherited OS env.
    expect(env.MODEL_AVAILABILITY_PROBE_TIMEOUT_MS).toBe('45000');
    // Forced desktop overrides stay authoritative.
    expect(env.PORT).toBe('4312');
    expect(env.HOST).toBe('0.0.0.0');
    // AUTH_TOKEN from .env is a non-default value -> kept as-is.
    expect(env.AUTH_TOKEN).toBe('from-user-env');
  });

  it('uses the app directory (with package.json) as backend cwd for packaged desktop builds', () => {
    expect(resolveDesktopServerWorkingDir({
      appPath: 'C:/Users/test/AppData/Local/Programs/Metapi/resources/app',
      resourcesPath: 'C:/Users/test/AppData/Local/Programs/Metapi/resources',
      isPackaged: true,
    })).toBe('C:/Users/test/AppData/Local/Programs/Metapi/resources/app');

    expect(resolveDesktopServerWorkingDir({
      appPath: '/workspace/metapi',
      resourcesPath: '/tmp/electron/resources',
      isPackaged: false,
    })).toBe('/workspace/metapi');
  });

  it('waits until the health probe returns ok', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    await expect(waitForServerReady({
      url: 'http://127.0.0.1:4312/api/desktop/health',
      fetcher,
      timeoutMs: 250,
      intervalMs: 1,
    })).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('fails when the health probe never becomes ready', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false });

    await expect(waitForServerReady({
      url: 'http://127.0.0.1:4312/api/desktop/health',
      fetcher,
      timeoutMs: 10,
      intervalMs: 1,
    })).rejects.toThrow('Timed out waiting for metapi desktop server');
  });

  it('treats non-zero non-signal exits as fatal', () => {
    expect(isFatalServerExit({ code: 1, signal: null })).toBe(true);
    expect(isFatalServerExit({ code: 0, signal: null })).toBe(false);
    expect(isFatalServerExit({ code: null, signal: 'SIGTERM' })).toBe(false);
  });
});
