// == Turnstile Solver 服务 ===================================================
// 调外部求解器 API 获取 Turnstile token，在签到遇 Turnstile 校验时自动求解。
// 支持两类求解器协议：同步 /solve，以及异步 createTask/getTaskResult
// （开源 turnstile-solver 等项目均兼容）。
// 配置从 settings 表 turnstile_solver_config 读（JSON：{enabled, baseUrl, apiKey, timeoutSeconds}）。
// -----------------------------------------------------------------------------

import { eq } from 'drizzle-orm';

const SETTING_KEY = 'turnstile_solver_config';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export type TurnstileSolverSettings = {
  enabled: boolean;
  baseUrl: string;     // e.g. http://127.0.0.1:5091（自建求解器）
  apiKey: string;
  timeoutSeconds: number;
};

export type SolveParams = {
  pageUrl: string;     // 目标页面 URL（用于 sitekey 与域名匹配）
  sitekey: string;     // Turnstile sitekey（0x4AAAA...）
  action?: string;     // data-action（可选）
};

export type SolveResult = {
  success: boolean;
  token?: string;
  userAgent?: string;
  message?: string;
};

// ---------------------------------------------------------------------------
// 读取求解器配置（settings 表 → env fallback）
// ---------------------------------------------------------------------------
export async function getTurnstileSolverSettings(): Promise<TurnstileSolverSettings | null> {
  try {
    const { db, schema } = await import('../db/index.js');
    const row = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, SETTING_KEY)).get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (parsed && typeof parsed === 'object') {
        const enabled = parsed.enabled !== false;
        const baseUrl = String(parsed.baseUrl || '').trim();
        // apiKey 可留空 —— 自建求解器（如 turnstile-solver 容器）通常无鉴权，
        // 云端求解服务才需要 key。
        const apiKey = String(parsed.apiKey || '').trim();
        if (enabled && baseUrl) {
          return {
            enabled: true,
            baseUrl,
            apiKey,
            timeoutSeconds: Math.min(180, Math.max(15, Number(parsed.timeoutSeconds) || 60)),
          };
        }
      }
    }
  } catch { /* silent — fall through to env fallback */ }

  // env fallback
  const envUrl = process.env.TURNSTILE_SOLVER_URL?.trim();
  const envKey = process.env.TURNSTILE_SOLVER_KEY?.trim() || '';
  const envEnabled = String(process.env.TURNSTILE_SOLVER_ENABLED || '').toLowerCase() !== 'false';
  if (envEnabled && envUrl) {
    return {
      enabled: true,
      baseUrl: envUrl,
      apiKey: envKey,
      timeoutSeconds: 60,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 判断签到失败消息是否因 Turnstile 校验
// ---------------------------------------------------------------------------
export function isTurnstileRequiredMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes('turnstile token 为空') ||
    (text.includes('turnstile') && (text.includes('token') || text.includes('校验') || text.includes('验证') || text.includes('verif')))
  );
}

// ---------------------------------------------------------------------------
// 求解 Turnstile（同步接口 /solve，兼容 async 格式）
// 优先调同步接口（直接返回 token），回退到 createTask+getTaskResult（轮询）
// ---------------------------------------------------------------------------
export async function solveTurnstileToken(
  settings: TurnstileSolverSettings,
  params: SolveParams,
  signal?: AbortSignal,
): Promise<SolveResult> {
  const { baseUrl, apiKey, timeoutSeconds } = settings;
  const timeoutMs = timeoutSeconds * 1000;

  // 1) 尝试同步接口 /solve（推荐）
  try {
    const result = await trySyncSolve(baseUrl, apiKey, params, timeoutMs, signal);
    if (result) return result;
  } catch {
    // 降级到异步任务
  }

  // 2) 回退到 createTask + getTaskResult（CapSolver/标准格式）
  try {
    const result = await tryAsyncSolve(baseUrl, apiKey, params, timeoutMs, signal);
    if (result) return result;
  } catch {
    // 完全失败
  }

  return { success: false, message: 'all solving attempts failed' };
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

async function trySyncSolve(
  baseUrl: string, apiKey: string, params: SolveParams,
  timeoutMs: number, signal?: AbortSignal,
): Promise<SolveResult | null> {
  const { fetch } = await import('undici');

  const body = JSON.stringify({
    url: params.pageUrl,
    sitekey: params.sitekey,
    ...(params.action ? { action: params.action } : {}),
    timeout: Math.ceil(timeoutMs / 1000),
  });

  const controller = new AbortController();
  const combinedAbort = signal ? abortSignals(signal, controller.signal) : controller.signal;

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'User-Agent': DEFAULT_UA,
      },
      body,
      signal: combinedAbort,
    });
    if (res.status !== 200) return null;
    const data: any = await res.json();
    if (data?.token && typeof data.token === 'string') {
      return { success: true, token: data.token, userAgent: data.user_agent, message: 'solved via /solve' };
    }
    if (data?.errorId) return { success: false, message: `solve failed: ${data.errorCode || data.errorDescription || 'unknown'}` };
    return null;
  } catch (err: any) {
    if (err?.name === 'AbortError') return null;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function tryAsyncSolve(
  baseUrl: string, apiKey: string, params: SolveParams,
  timeoutMs: number, signal?: AbortSignal,
): Promise<SolveResult | null> {
  const undici = await import('undici');
  const deadline = Date.now() + timeoutMs;
  // Bound every outbound call: a solver that accepts TCP but never answers
  // would otherwise hang the whole check-in pass (and the scheduler's stale
  // unlock would keep stacking new passes on top of it).
  const requestSignal = (): AbortSignal => {
    const timeoutSignal = AbortSignal.timeout(Math.max(1000, timeoutMs));
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  };

  // createTask
  const taskReq = await undici.fetch(`${baseUrl}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': DEFAULT_UA },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'TurnstileTaskProxyless',
        websiteURL: params.pageUrl,
        websiteKey: params.sitekey,
        ...(params.action ? { metadata: { action: params.action } } : {}),
      },
    }),
    signal: requestSignal(),
  });
  if (taskReq.status !== 200) return null;
  const taskData: any = await taskReq.json();
  if (taskData.errorId) return { success: false, message: `createTask failed: ${taskData.errorCode || taskData.errorDescription}` };
  const taskId: string | undefined = taskData.taskId;
  if (!taskId) return null;

  // poll getTaskResult（每 3 秒）
  while (Date.now() < deadline) {
    await sleep(3000);
    if (signal?.aborted) return null;
    try {
      const pollRes = await undici.fetch(`${baseUrl}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': DEFAULT_UA },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        signal: requestSignal(),
      });
      if (pollRes.status !== 200) continue;
      const pollData: any = await pollRes.json();
      if (pollData.errorId) return { success: false, message: `getTaskResult failed: ${pollData.errorCode}` };
      if (pollData.status === 'ready') {
        const tok = pollData.solution?.token;
        if (tok) return { success: true, token: tok, userAgent: pollData.solution?.userAgent, message: 'solved via async' };
      }
    } catch { continue; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function abortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) { controller.abort(sig.reason); return controller.signal; }
    sig.addEventListener('abort', () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}