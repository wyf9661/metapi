import { and, eq, gt, inArray, isNotNull, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { isUsableAccountToken } from './accountTokenService.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { proxyChannelCoordinator } from './proxyChannelCoordinator.js';
import { probeRuntimeModel } from './runtimeModelProbe.js';
import { tokenRouter } from './tokenRouter.js';
import { isExactTokenRouteModelPattern } from '../../shared/tokenRoutePatterns.js';

type ProbeCandidate = {
  channelId: number;
  modelName: string;
  tokenValue: string;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
};

// 配置常量（从 config 读取，保留兜底值）
const PROBE_SWEEP_INTERVAL_MS = config.probeHeartbeatIntervalMs ?? 120_000;
const PROBE_TIMEOUT_MS = config.probeHeartbeatTimeoutMs ?? 10_000;
const PROBE_CONCURRENCY = 1;
const PROBE_MAX_BATCH = 4;

let probeSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let probeSweepInFlight: Promise<void> | null = null;
const probeInFlightKeys = new Set<string>();
const probeLastStartedAtByKey = new Map<string, number>();

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

  if (getOauthInfoFromAccount(row.accounts)) {
    const accessToken = String(row.accounts.accessToken || '').trim();
    return accessToken || null;
  }

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
    }];
  });
}

/** 加载活跃通道（正在被路由使用的，有租约） */
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
    }];
  });
}

function shouldProbeCandidate(candidate: ProbeCandidate, nowMs: number): boolean {
  const key = buildProbeKey(candidate.channelId, candidate.modelName);
  if (probeInFlightKeys.has(key)) return false;
  const lastStartedAt = probeLastStartedAtByKey.get(key) ?? 0;
  // 同一通道最小探测间隔 = sweep 间隔，避免并发冲突
  return (nowMs - lastStartedAt) >= PROBE_SWEEP_INTERVAL_MS;
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
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.status === 'supported') {
      // 探活成功：仅记录成功时间，不清零冷却字段
      await tokenRouter.recordProbeSuccess(
        candidate.channelId,
        result.latencyMs ?? 0,
        candidate.modelName,
      );
    } else {
      // 探活失败：触发冷却机制（延长冷却、升级 level）
      await tokenRouter.recordFailure(
        candidate.channelId,
        { modelName: candidate.modelName },
      );
    }
  } catch (error) {
    // 网络/超时等异常也视为失败，触发冷却
    await tokenRouter.recordFailure(
      candidate.channelId,
      { modelName: candidate.modelName, errorText: error instanceof Error ? error.message : 'probe failed' },
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
    const [coolingCandidates, activeCandidates] = await Promise.all([
      loadCoolingProbeCandidates(nowIso),
      loadActiveProbeCandidates(activeChannelIds),
    ]);

    // 同一通道同时出现在冷却与活跃集合时，按活跃处理（冷却标记即将被清除）
    const merged = new Map<number, ProbeCandidate>();
    for (const candidate of [...activeCandidates, ...coolingCandidates]) {
      merged.set(candidate.channelId, candidate);
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
}