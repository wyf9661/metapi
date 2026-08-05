import { randomBytes } from 'node:crypto';

type DesktopServerEnvInput = {
  inheritedEnv?: NodeJS.ProcessEnv;
  userDataDir: string;
  logsDir: string;
  port: number;
};

type WaitForServerReadyInput = {
  url: string;
  fetcher?: (input: string, init?: RequestInit) => Promise<{ ok: boolean }>;
  timeoutMs?: number;
  intervalMs?: number;
};

type ServerExitState = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type DesktopServerWorkingDirInput = {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
};

const DEFAULT_DESKTOP_SERVER_PORT = 4000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 250;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInsecureDefaultSecret(value: string | undefined): boolean {
  const v = (value || '').trim();
  return (
    v.length === 0
    || v === 'change-me-admin-token'
    || v === 'change-me-proxy-sk-token'
    || v === '123456'
    || v === 'REPLACE_WITH_STRONG_RANDOM_SECRET'
  );
}

function generateRandomSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function buildDesktopServerEnv(input: DesktopServerEnvInput): NodeJS.ProcessEnv {
  const host = (input.inheritedEnv?.HOST || '0.0.0.0').trim() || '0.0.0.0';

  const env: NodeJS.ProcessEnv = {
    ...(input.inheritedEnv || {}),
    HOST: host,
    PORT: String(input.port),
    DATA_DIR: input.userDataDir,
    METAPI_DESKTOP: '1',
    METAPI_LOG_DIR: input.logsDir,
  };

  // The desktop build runs its backend as a managed local process. A normal
  // user cannot (and should not) set AUTH_TOKEN in the OS environment, so when
  // no strong token is provided we hand the server a fresh random admin login.
  // The user then changes it from the UI (ChangeKeyModal) which persists it to
  // the settings table — on restart runtimeSettingsHydration() overrides the
  // env with that persisted value, so a changed password survives. An
  // unchanged random token is a new value next launch, which is intended.
  if (isInsecureDefaultSecret(env.AUTH_TOKEN)) {
    env.AUTH_TOKEN = generateRandomSecret();
  }

  // The credential secret is the AES key for stored account/key secrets. Once
  // real encrypted data exists it MUST stay stable or existing rows unseal to
  // garbage, so only synthesize it when missing/default — never rotate it here.
  // config.ts falls back to AUTH_TOKEN, but assertProductionSecurity requires
  // it to differ from AUTH_TOKEN, so keep both explicit and distinct.
  if (
    isInsecureDefaultSecret(env.ACCOUNT_CREDENTIAL_SECRET)
    || env.ACCOUNT_CREDENTIAL_SECRET === env.AUTH_TOKEN
    || env.ACCOUNT_CREDENTIAL_SECRET === 'change-me-admin-token'
  ) {
    let secret = generateRandomSecret();
    while (secret === env.AUTH_TOKEN) {
      secret = generateRandomSecret();
    }
    env.ACCOUNT_CREDENTIAL_SECRET = secret;
  }

  return env;
}

export function createDesktopServerUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function createDesktopHealthUrl(port: number): string {
  return `${createDesktopServerUrl(port)}/api/desktop/health`;
}

export function resolveDesktopServerPort(env?: NodeJS.ProcessEnv): number {
  const forcedPort = Number.parseInt(env?.METAPI_DESKTOP_SERVER_PORT || '', 10);
  if (Number.isFinite(forcedPort) && forcedPort > 0) return forcedPort;
  return DEFAULT_DESKTOP_SERVER_PORT;
}

export function resolveDesktopServerWorkingDir(input: DesktopServerWorkingDirInput): string {
  // Packaged: appPath is <resources>/app, which holds both package.json (for
  // getCurrentRuntimeVersion) and dist/server. Pointing cwd there keeps the
  // backend's relative reads (e.g. package.json version) working inside a
  // read-only AppImage mount, unlike resourcesPath (one level up).
  return input.appPath;
}

export async function waitForServerReady(input: WaitForServerReadyInput): Promise<void> {
  const fetcher = input.fetcher || ((url: string, init?: RequestInit) => fetch(url, init));
  const timeoutMs = input.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const intervalMs = input.intervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetcher(input.url, { method: 'GET' });
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }
    await delay(intervalMs);
  }

  throw new Error('Timed out waiting for metapi desktop server');
}

export function isFatalServerExit(exitState: ServerExitState): boolean {
  return exitState.code !== null && exitState.code !== 0 && !exitState.signal;
}