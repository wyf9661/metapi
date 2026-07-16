import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { platform, arch } from 'node:os';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';

type TunnelStateFile = {
  enabled: boolean;
  tunnelUrl: string | null;
  publicUrl: string | null;
  shortId: string | null;
  pid: number | null;
  updatedAt: string | null;
  lastError: string | null;
};

type TunnelStatus = {
  enabled: boolean;
  running: boolean;
  settingsEnabled: boolean;
  tunnelUrl: string | null;
  publicUrl: string | null;
  shortId: string | null;
  dashboardAccess: boolean;
  downloading: boolean;
  downloadProgress: number | null;
  lastError: string | null;
  binaryPath: string | null;
};

const QUICK_TUNNEL_URL_RE = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi;
const SHORT_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DEFAULT_TUNNEL_WORKER_URL = 'https://abc-tunnel.us';

let child: ChildProcessWithoutNullStreams | null = null;
let currentTunnelUrl: string | null = null;
let currentShortId: string | null = null;
let currentPublicUrl: string | null = null;
let lastError: string | null = null;
let spawnInProgress = false;
let downloadInProgress = false;
let downloadProgress: number | null = null;
let enableToken = 0;

function tunnelDir(): string {
  return join(config.dataDir, 'tunnel');
}

function binDir(): string {
  return join(config.dataDir, 'bin');
}

function statePath(): string {
  return join(tunnelDir(), 'state.json');
}

function pidPath(): string {
  return join(tunnelDir(), 'cloudflared.pid');
}

function ensureDirs() {
  mkdirSync(tunnelDir(), { recursive: true });
  mkdirSync(binDir(), { recursive: true });
}

function binaryName(): string {
  return platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function binaryPath(): string {
  return join(binDir(), binaryName());
}

function tunnelWorkerBaseUrl(): string {
  return String(process.env.TUNNEL_WORKER_URL || DEFAULT_TUNNEL_WORKER_URL).trim().replace(/\/+$/, '') || DEFAULT_TUNNEL_WORKER_URL;
}

function buildStablePublicUrl(shortId: string | null | undefined): string | null {
  const id = String(shortId || '').trim().toLowerCase();
  if (!id) return null;
  return `https://r${id}.abc-tunnel.us`;
}

function generateShortId(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SHORT_ID_ALPHABET.charAt(Math.floor(Math.random() * SHORT_ID_ALPHABET.length));
  }
  return out;
}

function ensureShortId(existing?: string | null): string {
  const normalized = String(existing || currentShortId || '').trim().toLowerCase();
  if (/^[a-z0-9]{4,16}$/.test(normalized)) {
    currentShortId = normalized;
    return normalized;
  }
  const created = generateShortId();
  currentShortId = created;
  return created;
}

async function registerStableTunnelMapping(shortId: string, tunnelUrl: string): Promise<void> {
  const endpoint = `${tunnelWorkerBaseUrl()}/api/tunnel/register`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shortId, tunnelUrl }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`持久化公网地址注册失败: HTTP ${response.status}${text ? ` ${text.slice(0, 160)}` : ''}`);
  }
}

async function waitForPublicUrlHealthy(publicUrl: string, timeoutMs = 60000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(publicUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(5000),
      });
      // Any HTTP response means edge mapping is live (401/403 still OK).
      if (response.status > 0) return true;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

function readStateFile(): TunnelStateFile {
  try {
    if (!existsSync(statePath())) {
      return {
        enabled: false,
        tunnelUrl: null,
        publicUrl: null,
        shortId: null,
        pid: null,
        updatedAt: null,
        lastError: null,
      };
    }
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<TunnelStateFile>;
    return {
      enabled: !!raw.enabled,
      tunnelUrl: raw.tunnelUrl || null,
      publicUrl: raw.publicUrl || null,
      shortId: raw.shortId || null,
      pid: typeof raw.pid === 'number' ? raw.pid : null,
      updatedAt: raw.updatedAt || null,
      lastError: raw.lastError || null,
    };
  } catch {
    return {
      enabled: false,
      tunnelUrl: null,
      publicUrl: null,
      shortId: null,
      pid: null,
      updatedAt: null,
      lastError: null,
    };
  }
}

function writeStateFile(next: TunnelStateFile) {
  ensureDirs();
  writeFileSync(statePath(), JSON.stringify(next, null, 2), 'utf8');
}

function writePid(pid: number | null) {
  ensureDirs();
  if (pid == null) {
    try {
      if (existsSync(pidPath())) unlinkSync(pidPath());
    } catch {
      // ignore
    }
    return;
  }
  writeFileSync(pidPath(), String(pid), 'utf8');
}

function isProcessRunning(pid: number | null | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function extractQuickTunnelUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(QUICK_TUNNEL_URL_RE)) {
    const host = match[1];
    if (!host || host === 'api') continue;
    urls.push(`https://${host}.trycloudflare.com`);
  }
  return urls;
}

function downloadAssetName(): string {
  const p = platform();
  const a = arch();
  if (p === 'linux') {
    if (a === 'arm64') return 'cloudflared-linux-arm64';
    return 'cloudflared-linux-amd64';
  }
  if (p === 'darwin') {
    if (a === 'arm64') return 'cloudflared-darwin-arm64.tgz';
    return 'cloudflared-darwin-amd64.tgz';
  }
  if (p === 'win32') {
    if (a === 'arm64') return 'cloudflared-windows-amd64.exe';
    return 'cloudflared-windows-amd64.exe';
  }
  throw new Error(`Unsupported platform for cloudflared: ${p}/${a}`);
}

async function ensureCloudflaredBinary(): Promise<string> {
  ensureDirs();
  const target = binaryPath();
  if (existsSync(target)) {
    try {
      chmodSync(target, 0o755);
    } catch {
      // ignore
    }
    return target;
  }

  downloadInProgress = true;
  downloadProgress = 0;
  try {
    const asset = downloadAssetName();
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`下载 cloudflared 失败: HTTP ${response.status}`);
    }

    const total = Number(response.headers.get('content-length') || 0);
    let received = 0;
    const tmpFile = join(binDir(), `${asset}.download`);
    const fileStream = createWriteStream(tmpFile);
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (total > 0) downloadProgress = Math.min(99, Math.round((received / total) * 100));
      await new Promise<void>((resolve, reject) => {
        fileStream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve, reject) => {
      fileStream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });

    if (asset.endsWith('.tgz')) {
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xzf', tmpFile, '-C', binDir()], (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore
      }
      if (!existsSync(target)) {
        throw new Error('解压 cloudflared 后未找到可执行文件');
      }
    } else {
      const { renameSync } = await import('node:fs');
      renameSync(tmpFile, target);
    }

    chmodSync(target, 0o755);
    downloadProgress = 100;
    return target;
  } finally {
    downloadInProgress = false;
  }
}

async function waitForTunnelUrl(proc: ChildProcessWithoutNullStreams, timeoutMs = 45000): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('启动隧道超时：未从 cloudflared 输出中解析到公网 URL'));
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      buffer += text;
      if (buffer.length > 20000) buffer = buffer.slice(-20000);
      const urls = extractQuickTunnelUrls(buffer);
      if (urls.length > 0 && !settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(urls[urls.length - 1]!);
      }
    };

    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`cloudflared 已退出（code=${code ?? 'null'}）。最近日志：${buffer.slice(-500).trim() || '(empty)'}`));
    };

    const cleanup = () => {
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onData);
      proc.off('exit', onExit);
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', onExit);
  });
}

function killProcessTree(pid: number | null | undefined) {
  if (!pid || !isProcessRunning(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }
  try {
    // best-effort force after short delay handled by caller if needed
    process.kill(pid, 0);
  } catch {
    return;
  }
}

export async function stopCloudflareTunnel(options?: { persistDisabled?: boolean }): Promise<void> {
  enableToken += 1;
  const persistDisabled = options?.persistDisabled !== false;

  if (child && !child.killed) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  const pid = child?.pid || readStateFile().pid;
  killProcessTree(pid);
  child = null;
  currentTunnelUrl = null;
  // Keep shortId + stable public URL so the same address comes back after restart.
  currentPublicUrl = buildStablePublicUrl(currentShortId) || currentPublicUrl;
  writePid(null);

  if (persistDisabled) {
    config.tunnelEnabled = false;
    await upsertSetting('tunnel_enabled', false);
    writeStateFile({
      enabled: false,
      tunnelUrl: null,
      publicUrl: currentPublicUrl,
      shortId: currentShortId,
      pid: null,
      updatedAt: new Date().toISOString(),
      lastError,
    });
  }
}

export async function startCloudflareTunnel(): Promise<TunnelStatus> {
  if (spawnInProgress) {
    return getCloudflareTunnelStatus();
  }

  // already running with URL
  if (child && isProcessRunning(child.pid) && currentTunnelUrl) {
    return getCloudflareTunnelStatus();
  }

  spawnInProgress = true;
  const token = ++enableToken;
  lastError = null;

  try {
    const bin = await ensureCloudflaredBinary();
    if (token !== enableToken) {
      throw new Error('隧道启动已取消');
    }

    // stop any previous
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      child = null;
    }

    const localPort = config.port;
    const args = [
      'tunnel',
      '--url',
      `http://127.0.0.1:${localPort}`,
      '--no-autoupdate',
    ];

    const localTmp = join(tunnelDir(), 'tmp');
    mkdirSync(localTmp, { recursive: true });
    const proc = spawn(bin, args, {
      cwd: tunnelDir(),
      env: {
        ...process.env,
        TMPDIR: localTmp,
        TEMP: localTmp,
        TMP: localTmp,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams;

    child = proc;
    writePid(proc.pid ?? null);

    proc.on('exit', (code, signal) => {
      if (child === proc) {
        child = null;
        writePid(null);
        if (config.tunnelEnabled) {
          lastError = `cloudflared 意外退出 code=${code} signal=${signal || ''}`;
          writeStateFile({
            enabled: true,
            tunnelUrl: currentTunnelUrl,
            publicUrl: currentPublicUrl,
            shortId: currentShortId,
            pid: null,
            updatedAt: new Date().toISOString(),
            lastError,
          });
        }
      }
    });

    const tunnelUrl = await waitForTunnelUrl(proc);
    if (token !== enableToken) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      throw new Error('隧道启动已取消');
    }

    currentTunnelUrl = tunnelUrl;
    // Persist a stable shortId across restarts (Quick Tunnel URL itself always changes).
    const state = readStateFile();
    const shortId = ensureShortId(state.shortId || currentShortId);
    const stablePublicUrl = buildStablePublicUrl(shortId);
    currentShortId = shortId;
    currentPublicUrl = stablePublicUrl || tunnelUrl;

    try {
      await registerStableTunnelMapping(shortId, tunnelUrl);
      if (stablePublicUrl) {
        const healthy = await waitForPublicUrlHealthy(stablePublicUrl, 30000);
        if (!healthy) {
          console.warn(`[Tunnel] stable public URL not healthy yet, continue with ${stablePublicUrl}`);
        }
      }
    } catch (error: any) {
      // Fall back to direct trycloudflare URL if relay worker is unavailable.
      console.warn(`[Tunnel] stable mapping failed: ${error?.message || error}`);
      currentPublicUrl = tunnelUrl;
      lastError = error?.message || String(error);
    }

    config.tunnelEnabled = true;
    await upsertSetting('tunnel_enabled', true);
    writeStateFile({
      enabled: true,
      tunnelUrl: currentTunnelUrl,
      publicUrl: currentPublicUrl,
      shortId: currentShortId,
      pid: proc.pid ?? null,
      updatedAt: new Date().toISOString(),
      lastError: lastError,
    });

    return getCloudflareTunnelStatus();
  } catch (error: any) {
    lastError = error?.message || String(error);
    try {
      if (child) child.kill('SIGTERM');
    } catch {
      // ignore
    }
    child = null;
    writePid(null);
    writeStateFile({
      enabled: false,
      tunnelUrl: null,
      publicUrl: null,
      shortId: currentShortId,
      pid: null,
      updatedAt: new Date().toISOString(),
      lastError,
    });
    config.tunnelEnabled = false;
    await upsertSetting('tunnel_enabled', false);
    throw error;
  } finally {
    spawnInProgress = false;
  }
}

export function getCloudflareTunnelStatus(): TunnelStatus {
  const state = readStateFile();
  const shortId = currentShortId || state.shortId;
  const running = !!(child && isProcessRunning(child.pid) && (currentTunnelUrl || state.tunnelUrl));
  const enabled = !!(config.tunnelEnabled || state.enabled) && running;
  const tunnelUrl = currentTunnelUrl || state.tunnelUrl;
  const publicUrl = currentPublicUrl
    || buildStablePublicUrl(shortId)
    || state.publicUrl
    || tunnelUrl;
  return {
    enabled,
    running,
    settingsEnabled: !!(config.tunnelEnabled || state.enabled),
    tunnelUrl,
    publicUrl,
    shortId,
    dashboardAccess: !!config.tunnelDashboardAccess,
    downloading: downloadInProgress,
    downloadProgress,
    lastError: lastError || state.lastError,
    binaryPath: existsSync(binaryPath()) ? binaryPath() : null,
  };
}

export async function setTunnelDashboardAccess(enabled: boolean): Promise<void> {
  config.tunnelDashboardAccess = !!enabled;
  await upsertSetting('tunnel_dashboard_access', !!enabled);
}

export async function restoreCloudflareTunnelFromSettings(): Promise<void> {
  try {
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, 'tunnel_enabled')).get();
    let enabled = false;
    if (row?.value) {
      try {
        enabled = JSON.parse(row.value) === true;
      } catch {
        enabled = String(row.value).trim() === 'true';
      }
    }
    config.tunnelEnabled = enabled;
    if (enabled) {
      // fire-and-forget restore; do not block server boot on network
      void startCloudflareTunnel().catch((error) => {
        lastError = error?.message || String(error);
        console.warn(`[Tunnel] restore failed: ${lastError}`);
      });
    }
  } catch (error: any) {
    console.warn(`[Tunnel] restore skipped: ${error?.message || error}`);
  }
}

export function isLikelyTunnelRequest(request: {
  headers: Record<string, unknown> | { [key: string]: unknown };
  hostname?: string;
  protocol?: string;
}): boolean {
  const headers = request.headers || {};
  const cfRay = headers['cf-ray'] || headers['CF-Ray'];
  const cfConnecting = headers['cf-connecting-ip'] || headers['CF-Connecting-IP'];
  if (cfRay || cfConnecting) return true;

  const hostHeader = String(headers.host || request.hostname || '').split(':')[0].toLowerCase();
  if (hostHeader.endsWith('.trycloudflare.com')) return true;
  if (hostHeader.endsWith('.abc-tunnel.us')) return true;

  const status = getCloudflareTunnelStatus();
  if (status.publicUrl) {
    try {
      const publicHost = new URL(status.publicUrl).hostname.toLowerCase();
      if (hostHeader && hostHeader === publicHost) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export function isTunnelApiPath(urlPath: string): boolean {
  const path = (urlPath || '').split('?')[0] || '';
  if (path === '/v1' || path.startsWith('/v1/')) return true;
  // Claude/Gemini style proxy aliases if present
  if (path.startsWith('/api/v1/')) return true;
  return false;
}

export function isTunnelDashboardPath(urlPath: string): boolean {
  const path = (urlPath || '').split('?')[0] || '';
  // API proxy paths are never "dashboard surface"
  if (isTunnelApiPath(path)) return false;
  if (!path || path === '/') return true;
  if (path.startsWith('/assets/')) return true;
  if (path === '/index.html') return true;
  if (path.startsWith('/api/')) {
    // management APIs are dashboard surface
    return true;
  }
  // SPA routes
  if (!path.includes('.')) return true;
  return false;
}


function hydrateTunnelRuntimeFromDisk(): void {
  try {
    const state = readStateFile();
    if (state.shortId) currentShortId = state.shortId;
    if (state.publicUrl) currentPublicUrl = state.publicUrl;
    else if (state.shortId) currentPublicUrl = buildStablePublicUrl(state.shortId);
    if (state.tunnelUrl) currentTunnelUrl = state.tunnelUrl;
    if (state.lastError) lastError = state.lastError;
  } catch {
    // ignore
  }
}

hydrateTunnelRuntimeFromDisk();
