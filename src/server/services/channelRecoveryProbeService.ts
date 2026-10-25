import {and, eq, gt, inArray, isNotNull, sql} from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config, resolveProbeHeartbeatTimeoutMs } from '../config.js';
import { isUsableAccountToken } from './accountTokenService.js';
import { proxyChannelCoordinator } from './proxyChannelCoordinator.js';
import { probeRuntimeModel } from './runtimeModelProbe.js';
import { isQuotaOrCreditFailureText } from './siteFailureClassification.js';
import { tokenRouter } from './tokenRouter.js';
import { isExactTokenRouteModelPattern } from '../../shared/tokenRoutePatterns.js';

type ProbeCandidate = {
  channelId: number;
  modelName: string;
  tokenValue: string;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  /** Consecutive failures of the channel drive the probe backoff interval. */
  consecutiveFailCount: number;
};

// 配置常量（从 config 读取，保留兜底值）
const PROBE_SWEEP_INTERVAL_MS = config.probeHeartbeatIntervalMs ?? 120_000;
// 探测预算跟随代理首字窗口（见 config.resolveProbeHeartbeatTimeoutMs）：
// 探测比真实请求更早放弃，就会把「慢但健康」的站判死，冷冷却反过来把它挡在
// 路由之外。单轮最多 4 个、并发 2，最坏耗时随首字窗口线性增长（首字 90s 时
// 约 180s），跨轮重叠由 probeSweepInFlight 兜住，不会并发叠加。
const PROBE_CONCURRENCY = 2;
const PROBE_MAX_BATCH = 4;

let probeSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let probeSweepInFlight: Promise<void> | null = null;
const probeInFlightKeys = new Set<string>();
const probeLastStartedAtByKey = new Map<string, number>();
// 回填用：从 probe_logs 恢复的「账号+模型」最近一次探测时间（进程内一次性）。
const seededProbeLastStartedAtByAccountModel = new Map<string, number>();
let probeLastStartedAtSeeded = false;
const PROBE_SEED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function buildAccountModelKey(accountId: number, modelName: string): string {
  return `${Math.trunc(accountId || 0)}:${String(modelName || '').trim().toLowerCase()}`;
}

/** probe_logs.created_at 由 SQLite datetime('now') 写入，格式为
 *  "YYYY-MM-DD HH:MM:SS"（UTC，无时区后缀），这里显式按 UTC 解析。 */
function parseProbeLogTimestampMs(value: unknown): number | null {
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 进程重启后内存里的「上次探测时间」会清空。若把未知键当成「早已到期」，
 * 启动瞬间就会把所有冷却渠道集中补探一轮。这里在首次 sweep 时用
 * probe_logs 回填最近一次探测时间，让恢复探测沿用重启前的真实节奏；
 * 从未探测过的渠道仍按原逻辑立即进入队列（每轮至多 PROBE_MAX_BATCH 个）。
 */
async function seedProbeLastStartedAtFromLogs(nowMs: number): Promise<void> {
  if (probeLastStartedAtSeeded) return;
  probeLastStartedAtSeeded = true;
  try {
    const sinceSql = new Date(nowMs - PROBE_SEED_LOOKBACK_MS)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    const rows = await db.select({
      accountId: schema.probeLogs.accountId,
      modelName: schema.probeLogs.modelName,
      lastAt: sql<unknown>`max(${schema.probeLogs.createdAt})`,
    })
      .from(schema.probeLogs)
      .where(gt(schema.probeLogs.createdAt, sinceSql))
      .groupBy(schema.probeLogs.accountId, schema.probeLogs.modelName)
      .all();

    for (const row of rows) {
      const lastAtMs = parseProbeLogTimestampMs(row.lastAt);
      if (lastAtMs == null) continue;
      seededProbeLastStartedAtByAccountModel.set(
        buildAccountModelKey(Number(row.accountId), String(row.modelName || '')),
        lastAtMs,
      );
    }
  } catch (error) {
    console.warn('[channel-probe] failed to seed probe timestamps from probe_logs', error);
  }
}

function shouldUnrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>) {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function buildProbeKey(channelId: number, modelName: string): string {
  return `${channelId}:${String(modelName || '').trim().toLowerCase()}`;
}

function resolveProbeModelName(row: {
  route_channels: typeof schema.routeChannels.$inferSelect;
  token_routes: typeof schema.tokenRoutes.$inferSelect;
}): string {
  const sourceModel = String(row.route_channels.sourceModel || '').trim();
  if (sourceModel) return sourceModel;
  const routeModelPattern = String(row.token_routes.modelPattern || '').trim();
  return isExactTokenRouteModelPattern(routeModelPattern) ? routeModelPattern : '';
}

function resolveProbeTokenValue(row: {
  route_channels: typeof schema.routeChannels.$inferSelect;
  accounts: typeof schema.accounts.$inferSelect;
  account_tokens: typeof schema.accountTokens.$inferSelect | null;
}): string | null {
  if (typeof row.route_channels.tokenId === 'number' && row.route_channels.tokenId > 0) {
    if (!row.account_tokens || !isUsableAccountToken(row.account_tokens)) return null;
    const tokenValue = String(row.account_tokens.token || '').trim();
    return tokenValue || null;
  }

  const accessToken = String(row.accounts.accessToken || '').trim();
  if (accessToken) return accessToken;

  const fallbackApiToken = String(row.accounts.apiToken || '').trim();
  return fallbackApiToken || null;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, Math.trunc(concurrency || 1)));
  let nextIndex = 0;
  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      await worker(items[currentIndex] as T, currentIndex);
    }
  };
  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
}

/**
 * Provider 主动下发的配额/额度冷却（例如余额耗尽、限流禁言）不参与自动恢复探测，
 * 因为它们只能通过充值或人工解除，探测不会改变结果。
 */
function isProviderDirectedCooldown(row: {
  route_channels: typeof schema.routeChannels.$inferSelect;
}): boolean {
  return !!row.route_channels.cooldownUntil
    && (row.route_channels.failCount ?? 0) <= 0
    && (row.route_channels.consecutiveFailCount ?? 0) <= 0
    && (row.route_channels.cooldownLevel ?? 0) <= 0;
}

/** 加载冷却中、需要恢复探测的通道（排除 provider 主动冷却） */
async function loadCoolingProbeCandidates(nowIso: string): Promise<ProbeCandidate[]> {
  const rows = await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(and(
      eq(schema.routeChannels.enabled, true),
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
      isNotNull(schema.routeChannels.cooldownUntil),
      gt(schema.routeChannels.cooldownUntil, nowIso),
    ))
    .all();

  return rows.flatMap((row: any) => {
    if (isProviderDirectedCooldown(row)) return [];
    const modelName = resolveProbeModelName(row);
    const tokenValue = resolveProbeTokenValue(row);
    if (!modelName || !tokenValue) return [];
    return [{
      channelId: row.route_channels.id,
      modelName,
      tokenValue,
      account: row.accounts,
      site: row.sites,
      consecutiveFailCount: Number(row.route_channels.consecutiveFailCount ?? 0),
    }];
  });
}

/** Load active channels (those being routed, holding a lease) */
async function loadActiveProbeCandidates(activeChannelIds: number[]): Promise<ProbeCandidate[]> {
  if (activeChannelIds.length <= 0) return [];

  const rows = await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(and(
      eq(schema.routeChannels.enabled, true),
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
      inArray(schema.routeChannels.id, activeChannelIds),
    ))
    .all();

  return rows.flatMap((row: any) => {
    const modelName = resolveProbeModelName(row);
    const tokenValue = resolveProbeTokenValue(row);
    if (!modelName || !tokenValue) return [];
    return [{
      channelId: row.route_channels.id,
      modelName,
      tokenValue,
      account: row.accounts,
      site: row.sites,
      consecutiveFailCount: Number(row.route_channels.consecutiveFailCount ?? 0),
    }];
  });
}

/**
 * 指数退避的探测间隔（探测专用，与渠道冷却互相独立）：
 * 0 次失败 -> 基准 sweep 间隔；n 次失败 -> base * 2^(n-1)，封顶 1 小时。
 * 每次叠加 ±25% 随机抖动，避免多渠道形成可被上游识别的规律性探测节奏
 * （冷却时长同样带抖动，见 tokenRouter.recordProbeFailure）。
 * 渠道恢复（探测成功）后计数清零，间隔回到基准。
 */
function resolveProbeBackoffMs(candidate: ProbeCandidate): number {
  const fails = Math.max(0, Math.trunc(candidate.consecutiveFailCount ?? 0));
  // 与 tokenRouter.recordProbeFailure 的冷却公式同源：base * 2^n，封顶 1h。
  // n=0（未失败）→ base；n=1 → 4min；n=2 → 8min；…；封顶 60min。
  const exponentialMs = fails <= 0
    ? PROBE_SWEEP_INTERVAL_MS
    : PROBE_SWEEP_INTERVAL_MS * Math.pow(2, Math.min(fails, 9));
  const clampedMs = Math.min(exponentialMs, PROBE_INTERVAL_CAP_MS);
  return applyJitterMs(clampedMs);
}

// 探测间隔上限：1 小时。与失败冷却上限同量级——冷却中的渠道最多每小时
// 被探测一次，上游视角是稀疏的单次健康检查而非持续流量。
const PROBE_INTERVAL_CAP_MS = 60 * 60 * 1000;

// ±25% 抖动：退避仍单调增长（趋势可预期），但相邻值不可精确预测。
const PROBE_JITTER_RATIO = 0.25;

function applyJitterMs(baseMs: number): number {
  const jitter = 1 + (Math.random() * 2 - 1) * PROBE_JITTER_RATIO;
  const jittered = Math.round(baseMs * jitter);
  // 抖动不得突破上限，也不得短于基准间隔。
  return Math.max(PROBE_SWEEP_INTERVAL_MS, Math.min(jittered, PROBE_INTERVAL_CAP_MS));
}

function shouldProbeCandidate(candidate: ProbeCandidate, nowMs: number): boolean {
  const key = buildProbeKey(candidate.channelId, candidate.modelName);
  if (probeInFlightKeys.has(key)) return false;
  const lastStartedAt = probeLastStartedAtByKey.get(key) ?? 0;
  // Backoff grows with consecutive failures so a struggling channel is not
  // hammered every sweep (each probe is a real upstream call that bills).
  return (nowMs - lastStartedAt) >= resolveProbeBackoffMs(candidate);
}

function compareProbeCandidatePriority(left: ProbeCandidate, right: ProbeCandidate): number {
  const leftKey = buildProbeKey(left.channelId, left.modelName);
  const rightKey = buildProbeKey(right.channelId, right.modelName);
  const leftLastStartedAt = probeLastStartedAtByKey.get(leftKey);
  const rightLastStartedAt = probeLastStartedAtByKey.get(rightKey);

  if (leftLastStartedAt == null && rightLastStartedAt == null) {
    return left.channelId - right.channelId;
  }
  if (leftLastStartedAt == null) return -1;
  if (rightLastStartedAt == null) return 1;
  if (leftLastStartedAt !== rightLastStartedAt) {
    return leftLastStartedAt - rightLastStartedAt;
  }
  return left.channelId - right.channelId;
}

async function runProbeCandidate(candidate: ProbeCandidate, nowMs: number): Promise<void> {
  const key = buildProbeKey(candidate.channelId, candidate.modelName);
  probeInFlightKeys.add(key);
  probeLastStartedAtByKey.set(key, nowMs);
  try {
    const result = await probeRuntimeModel({
      site: candidate.site,
      account: candidate.account,
      modelName: candidate.modelName,
      tokenValue: candidate.tokenValue,
      timeoutMs: resolveProbeHeartbeatTimeoutMs(),
    });
    if (result.status === 'supported') {
      // 探活成功：清冷却、清退避计数，渠道恢复
      await tokenRouter.recordProbeSuccess(
        candidate.channelId,
        result.latencyMs ?? 0,
        candidate.modelName,
      );
    } else {
      // 探测失败（unsupported=上游明确拒绝 / inconclusive=超时或未完成）：
      // 渠道仍未恢复，走探测专用失败路径——指数退避延长冷却（带随机抖动，
      // 避免多渠道同步出价的探测节奏被上游识别），冷却期内完全不探测。
      //
      // 余额/配额耗尽例外：这类错误只有充值/人工解除才能改变，探测不会让它
      // 恢复。把它标成 provider 主动冷却，渠道直接退出探测池，不再空打。
      const quotaExhausted = isQuotaOrCreditFailureText(result.reason);
      await tokenRouter.recordProbeFailure(
        candidate.channelId,
        {
          inconclusive: result.status !== 'unsupported',
          quotaExhausted,
        },
        nowMs,
      );
    }
  } catch {
    // 网络/超时异常：探测未能完成，等同 inconclusive，走同一退避路径。
    await tokenRouter.recordProbeFailure(
      candidate.channelId,
      { inconclusive: true },
      nowMs,
    );
  } finally {
    probeInFlightKeys.delete(key);
  }
}

export async function runChannelProbeSweep(nowMs = Date.now()): Promise<void> {
  if (probeSweepInFlight) {
    await probeSweepInFlight;
    return;
  }

  probeSweepInFlight = (async () => {
    const nowIso = new Date(nowMs).toISOString();
    const activeChannelIds = proxyChannelCoordinator.getActiveChannelIds();
    // 重启后先用历史探测记录回填节奏，再决定本轮谁到期。
    await seedProbeLastStartedAtFromLogs(nowMs);
    const [coolingCandidates, activeCandidates] = await Promise.all([
      loadCoolingProbeCandidates(nowIso),
      loadActiveProbeCandidates(activeChannelIds),
    ]);

    // 同一通道同时出现在冷却与活跃集合时，按活跃处理（冷却标记即将被清除）
    const merged = new Map<number, ProbeCandidate>();
    for (const candidate of [...activeCandidates, ...coolingCandidates]) {
      merged.set(candidate.channelId, candidate);
    }

    // 内存计时器没有该渠道时，用历史记录（账号+模型维度）回填一次，避免
    // 重启后被误判为「从未探测过」而立刻补探。
    for (const candidate of merged.values()) {
      const key = buildProbeKey(candidate.channelId, candidate.modelName);
      if (probeLastStartedAtByKey.has(key)) continue;
      const seeded = seededProbeLastStartedAtByAccountModel.get(
        buildAccountModelKey(candidate.account.id, candidate.modelName),
      );
      if (seeded != null) probeLastStartedAtByKey.set(key, seeded);
    }

    const dueCandidates = Array.from(merged.values())
      .filter((candidate) => shouldProbeCandidate(candidate, nowMs))
      .sort(compareProbeCandidatePriority)
      .slice(0, PROBE_MAX_BATCH);

    if (dueCandidates.length <= 0) return;

    await mapWithConcurrency(
      dueCandidates,
      PROBE_CONCURRENCY,
      async (candidate) => runProbeCandidate(candidate, nowMs),
    );
  })().finally(() => {
    probeSweepInFlight = null;
  });

  await probeSweepInFlight;
}

export function startChannelProbeScheduler(intervalMs = PROBE_SWEEP_INTERVAL_MS): { enabled: boolean; intervalMs: number } {
  stopChannelProbeScheduler();
  const safeIntervalMs = Math.max(60_000, Math.trunc(intervalMs || 0)); // 最小 60s
  probeSchedulerTimer = setInterval(() => {
    void runChannelProbeSweep().catch((error) => {
      console.warn('[channel-probe] background sweep failed', error);
    });
  }, safeIntervalMs);
  shouldUnrefTimer(probeSchedulerTimer);
  void runChannelProbeSweep().catch((error) => {
    console.warn('[channel-probe] initial sweep failed', error);
  });
  return { enabled: true, intervalMs: safeIntervalMs };
}

export function stopChannelProbeScheduler(): void {
  if (probeSchedulerTimer) {
    clearInterval(probeSchedulerTimer);
    probeSchedulerTimer = null;
  }
}

export function resetChannelProbeState(): void {
  stopChannelProbeScheduler();
  probeSweepInFlight = null;
  probeInFlightKeys.clear();
  probeLastStartedAtByKey.clear();
  seededProbeLastStartedAtByAccountModel.clear();
  probeLastStartedAtSeeded = false;
}