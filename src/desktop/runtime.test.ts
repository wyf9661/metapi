import { describe, expect, it, vi } from 'vitest';
import {
  buildDesktopServerEnv,
  createDesktopServerUrl,
  isFatalServerExit,
  resolveDesktopServerPort,
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
