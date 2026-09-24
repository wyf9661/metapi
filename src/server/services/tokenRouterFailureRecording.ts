/**
 * Failure / recovery bookkeeping for route channels.
 *
 * Extracted from tokenRouter.ts: these helpers touch only the database, the
 * runtime health store and the routing caches, and hold no instance state — so
 * they live at module scope, and TokenRouter keeps thin delegates so its public
 * API is unchanged.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { getCredentialModeFromExtraConfig } from './accountExtraConfig.js';
import { refreshBalance } from './balanceService.js';
import { resolveRouteStrategy } from './tokenRouterCandidateHelpers.js';
import { SITE_API_ENDPOINT_COOLDOWN_MS } from './siteApiEndpointService.js';
import {
  classifyProxyFailure,
  type SiteRuntimeFailureContext,
} from './siteFailureClassification.js';
import {
  clampFailureCooldownMs,
  resolveEffectiveFailureCooldownMs,
  resolveFailureCooldownWeight,
  resolveShortWindowLimitCooldown,
} from './tokenRouterFailurePolicy.js';
import { ROUND_ROBIN_COOLDOWN_LEVELS_SEC, resolveRoundRobinCooldownSec } from './tokenRouterMath.js';
import {
  invalidateRouteScopedCache,
  invalidateTokenRouterCache,
  patchCachedChannel,
} from './tokenRouterRouteCache.js';
import {
  clearRuntimeHealthStatesForChannels,
  ensureSiteRuntimeHealthStateLoaded,
  persistSiteRuntimeHealthState,
  recordSiteRuntimeFailure,
  recordSiteRuntimeSuccess,
} from './tokenRouterRuntimeHealthStore.js';

// 余额/配额耗尽（"Insufficient Balance" 等）的固定冷却：这类状态只能靠充值或
// 人工解除，恢复探测对它无效。用一个小时量级的固定冷却把渠道从探测池里摘出去，
// 同时保留路由层 1 小时后自动复检一次的机会（与「冷却上限 1 小时」的约定一致）。
const QUOTA_EXHAUSTED_COOLDOWN_MS = 60 * 60 * 1000;
const ROUND_ROBIN_FAILURE_THRESHOLD = 3;

async function loadCredentialScopedChannelIds(
  channel: typeof schema.routeChannels.$inferSelect,
  accountId: number,
): Promise<number[]> {
  if (typeof channel.tokenId === 'number' && channel.tokenId > 0) {
    const rows = await db.select({ id: schema.routeChannels.id })
      .from(schema.routeChannels)
      .where(eq(schema.routeChannels.tokenId, channel.tokenId))
      .all();
    return rows.map((row: any) => row.id);
  }

  const rows = await db.select({ id: schema.routeChannels.id })
    .from(schema.routeChannels)
    .where(and(
      eq(schema.routeChannels.accountId, accountId),
      isNull(schema.routeChannels.tokenId),
    ))
    .all();
  return rows.map((row: any) => row.id);
}

/**
 * Record success for a channel.
 */
export async function recordSuccess(
  channelId: number,
  latencyMs: number,
  cost: number,
  modelName?: string | null,
  actualAccountId?: number,
) {
  await ensureSiteRuntimeHealthStateLoaded();
  const row = await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .where(eq(schema.routeChannels.id, channelId))
    .get();
  if (!row) return;
  const ch = row.route_channels;
  const account = row.accounts;
  const nowIso = new Date().toISOString();
  const nextSuccessCount = (ch.successCount ?? 0) + 1;
  const nextTotalLatencyMs = (ch.totalLatencyMs ?? 0) + latencyMs;
  const nextTotalCost = (ch.totalCost ?? 0) + cost;
  if (typeof ch.oauthRouteUnitId === 'number' && ch.oauthRouteUnitId > 0) {
    const targetAccountId = Number.isFinite(actualAccountId) && (actualAccountId ?? 0) > 0
      ? Math.trunc(actualAccountId!)
      : account.id;
    const memberRow = await db.select({
      member: schema.oauthRouteUnitMembers,
      account: schema.accounts,
    }).from(schema.oauthRouteUnitMembers)
      .innerJoin(schema.accounts, eq(schema.oauthRouteUnitMembers.accountId, schema.accounts.id))
      .where(and(
        eq(schema.oauthRouteUnitMembers.unitId, ch.oauthRouteUnitId),
        eq(schema.oauthRouteUnitMembers.accountId, targetAccountId),
      ))
      .get();

    if (memberRow) {
      const memberSuccessCount = (memberRow.member.successCount ?? 0) + 1;
      const memberTotalLatencyMs = (memberRow.member.totalLatencyMs ?? 0) + latencyMs;
      const memberTotalCost = (memberRow.member.totalCost ?? 0) + cost;
      await db.update(schema.oauthRouteUnitMembers).set({
        successCount: memberSuccessCount,
        totalLatencyMs: memberTotalLatencyMs,
        totalCost: memberTotalCost,
        lastUsedAt: nowIso,
        failCount: 0,
        cooldownUntil: null,
        lastFailAt: null,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
        updatedAt: nowIso,
      }).where(eq(schema.oauthRouteUnitMembers.id, memberRow.member.id)).run();
      recordSiteRuntimeSuccess(memberRow.account.siteId, latencyMs, modelName);
    } else {
      recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName);
    }
    invalidateRouteScopedCache(ch.routeId);
  } else {
    recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName);
  }

  await db.update(schema.routeChannels).set({
    successCount: nextSuccessCount,
    totalLatencyMs: nextTotalLatencyMs,
    totalCost: nextTotalCost,
    lastUsedAt: nowIso,
    failCount: 0,
    cooldownUntil: null,
    lastFailAt: null,
    consecutiveFailCount: 0,
    cooldownLevel: 0,
  }).where(eq(schema.routeChannels.id, channelId)).run();

  patchCachedChannel(channelId, (channel) => {
    channel.successCount = nextSuccessCount;
    channel.totalLatencyMs = nextTotalLatencyMs;
    channel.totalCost = nextTotalCost;
    channel.lastUsedAt = nowIso;
    channel.failCount = 0;
    channel.cooldownUntil = null;
    channel.lastFailAt = null;
    channel.consecutiveFailCount = 0;
    channel.cooldownLevel = 0;
  });
}

export async function recordProbeSuccess(
  channelId: number,
  latencyMs: number,
  modelName?: string | null,
  actualAccountId?: number,
) {
  await ensureSiteRuntimeHealthStateLoaded();
  const row = await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .where(eq(schema.routeChannels.id, channelId))
    .get();
  if (!row) return;

  const ch = row.route_channels;
  const account = row.accounts;
  if (typeof ch.oauthRouteUnitId === 'number' && ch.oauthRouteUnitId > 0) {
    const targetAccountId = Number.isFinite(actualAccountId) && (actualAccountId ?? 0) > 0
      ? Math.trunc(actualAccountId!)
      : account.id;
    const nowIso = new Date().toISOString();
    const memberRow = await db.select({
      member: schema.oauthRouteUnitMembers,
      account: schema.accounts,
    }).from(schema.oauthRouteUnitMembers)
      .innerJoin(schema.accounts, eq(schema.oauthRouteUnitMembers.accountId, schema.accounts.id))
      .where(and(
        eq(schema.oauthRouteUnitMembers.unitId, ch.oauthRouteUnitId),
        eq(schema.oauthRouteUnitMembers.accountId, targetAccountId),
      ))
      .get();

    if (memberRow) {
      await db.update(schema.oauthRouteUnitMembers).set({
        cooldownUntil: null,
        lastFailAt: null,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
        updatedAt: nowIso,
      }).where(eq(schema.oauthRouteUnitMembers.id, memberRow.member.id)).run();
      recordSiteRuntimeSuccess(memberRow.account.siteId, latencyMs, modelName);
    } else {
      recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName);
    }

    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).where(eq(schema.routeChannels.id, channelId)).run();
    patchCachedChannel(channelId, (channel) => {
      channel.cooldownUntil = null;
      channel.lastFailAt = null;
      channel.consecutiveFailCount = 0;
      channel.cooldownLevel = 0;
    });
    invalidateRouteScopedCache(ch.routeId);
    return;
  }

  const affectedChannelIds = await loadCredentialScopedChannelIds(ch, account.id);
  const needsChannelReset = !!ch.cooldownUntil
    || !!ch.lastFailAt
    || (ch.consecutiveFailCount ?? 0) > 0
    || (ch.cooldownLevel ?? 0) > 0;

  if (needsChannelReset) {
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).where(inArray(schema.routeChannels.id, affectedChannelIds)).run();

    for (const affectedChannelId of affectedChannelIds) {
      patchCachedChannel(affectedChannelId, (channel) => {
        channel.cooldownUntil = null;
        channel.lastFailAt = null;
        channel.consecutiveFailCount = 0;
        channel.cooldownLevel = 0;
      });
    }
  } else if (affectedChannelIds.length > 1) {
    const scopedRows = await db.select({
      id: schema.routeChannels.id,
      cooldownUntil: schema.routeChannels.cooldownUntil,
      lastFailAt: schema.routeChannels.lastFailAt,
      consecutiveFailCount: schema.routeChannels.consecutiveFailCount,
      cooldownLevel: schema.routeChannels.cooldownLevel,
    })
      .from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, affectedChannelIds))
      .all();
    const siblingIdsToReset = scopedRows
      .filter((candidate: any) => candidate.id !== channelId && (
        !!candidate.cooldownUntil
        || !!candidate.lastFailAt
        || (candidate.consecutiveFailCount ?? 0) > 0
        || (candidate.cooldownLevel ?? 0) > 0
      ))
      .map((candidate: any) => candidate.id);

    if (siblingIdsToReset.length > 0) {
      await db.update(schema.routeChannels).set({
        cooldownUntil: null,
        lastFailAt: null,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      }).where(inArray(schema.routeChannels.id, siblingIdsToReset)).run();

      for (const siblingId of siblingIdsToReset) {
        patchCachedChannel(siblingId, (channel) => {
          channel.cooldownUntil = null;
          channel.lastFailAt = null;
          channel.consecutiveFailCount = 0;
          channel.cooldownLevel = 0;
        });
      }
    }
  }

  recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName);
}

/**
 * True when the channel's cooldown was written by the recovery-probe path
 * rather than by a real request failure.
 *
 * `recordProbeFailure` bumps `consecutiveFailCount` (it doubles as the probe's
 * own backoff driver) and deliberately never touches `failCount`; every
 * `recordFailure` branch — fibonacci, round-robin, short-window credential
 * (usage limit) and provider-directed quota — resets `consecutiveFailCount` to
 * 0. A positive value therefore means the most recent writer was a health
 * probe: a PREDICTION about the channel, not an observation of it.
 *
 * Routing reads this to relax a probe-induced cooldown when it would otherwise
 * be the ONLY reason the candidate pool is empty. Real-failure and
 * credential-scoped cooldowns stay hard exclusions — a usage-limited account
 * must not be retried just because it is the last candidate left.
 */
export function isProbeAttributableCooldown(channel: {
  consecutiveFailCount?: number | null;
}): boolean {
  return (channel.consecutiveFailCount ?? 0) > 0;
}

/**
 * Probe-only failure path: a failed liveness probe must NOT reuse
 * recordFailure — the probe passes no status/errorText, so classifyProxyFailure
 * would land on 'unknown' (skipCooldown) and CLEAR the cooldown, throwing the
 * dead channel straight back into live traffic.
 *
 * Instead, extend the cooldown with an exponential backoff (jittered so many
 * channels do not form a recognizable synchronized probe rhythm upstream) and
 * keep the channel fully out of routing AND probing until it expires:
 *   fail #1 -> ~4min, #2 -> ~8min, #3 -> ~16min, #4 -> ~32min, #5+ -> ~1h.
 * Success (recordProbeSuccess) resets consecutiveFailCount to 0.
 *
 * The probe streak only advances consecutiveFailCount. failCount belongs to
 * REAL traffic failures (it feeds the fibonacci cooldown), so probe attempts
 * must never inflate it.
 *
 * quotaExhausted (upstream balance/credit exhaustion) is a provider-side
 * state that only a recharge can change: the channel is parked as a
 * provider-directed cooldown (all counters zeroed) so the probe loop stops
 * hitting an upstream that can never answer.
 */
export async function recordProbeFailure(
  channelId: number,
  options: { inconclusive?: boolean; quotaExhausted?: boolean } = {},
  nowMs: number = Date.now(),
) {
  const normalizedChannelId = Math.trunc(channelId || 0);
  if (normalizedChannelId <= 0) return;
  await ensureSiteRuntimeHealthStateLoaded();

  const row = await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .where(eq(schema.routeChannels.id, normalizedChannelId))
    .get();
  if (!row) return;

  const ch = row.route_channels;
  const route = row.token_routes;
  const nowIso = new Date(nowMs).toISOString();

  // 余额/配额耗尽（"Insufficient Balance"、402 等）是上游单方面状态：只有充值或
  // 人工解除才会改变，探测永远不可能让它恢复。此时把渠道写成「provider 主动
  // 冷却」形态（failCount/consecutiveFailCount/cooldownLevel 全部归零），
  // isProviderDirectedCooldown 会据此把它排除出探测池——否则失败计数 >0，
  // 探测循环会一轮轮空打一个永远不会活的渠道。
  if (options.quotaExhausted) {
    const providerCooldownUntil = new Date(nowMs + QUOTA_EXHAUSTED_COOLDOWN_MS).toISOString();
    await db.update(schema.routeChannels).set({
      failCount: 0,
      lastFailAt: nowIso,
      consecutiveFailCount: 0,
      cooldownUntil: providerCooldownUntil,
      cooldownLevel: 0,
    }).where(eq(schema.routeChannels.id, normalizedChannelId)).run();

    patchCachedChannel(normalizedChannelId, (channel) => {
      channel.failCount = 0;
      channel.lastFailAt = nowIso;
      channel.consecutiveFailCount = 0;
      channel.cooldownUntil = providerCooldownUntil;
      channel.cooldownLevel = 0;
    });

    invalidateRouteScopedCache(route.id);
    return;
  }

  const consecutiveFailCount = Math.max(0, ch.consecutiveFailCount ?? 0) + 1;
  // failCount 只属于真实流量失败（它驱动 fibonacci 冷却）。探测尝试不能
  // 把它顶到上限——否则一个渠道被探测十几次后，下一次真实失败的冷却就直接
  // 顶格 1 小时。探测自身的节奏由 consecutiveFailCount 驱动。
  const failCount = ch.failCount ?? 0;
  // 指数退避：base(2min) * 2^n，封顶 1h。±25% 抖动打散多渠道的同步节奏。
  const baseIntervalMs = Math.max(60_000, Math.trunc(config.probeHeartbeatIntervalMs || 120_000));
  const exponentialMs = Math.min(
    baseIntervalMs * Math.pow(2, Math.min(consecutiveFailCount, 9)),
    60 * 60 * 1000,
  );
  const jitteredMs = Math.round(exponentialMs * (1 + (Math.random() * 2 - 1) * 0.25));
  const probeBackoffMs = Math.max(60_000, Math.min(jitteredMs, 60 * 60 * 1000));
  // 冷却在探测退避基础上再延长一个 sweep 周期，确保渠道在到达下一次探测
  // 时刻时仍处于冷却集合（cooldownUntil > now），不会因精确边界把该探测
  // 漏掉。对路由而言多冷却一轮是保守的，代价可忽略。
  const cooldownMs = probeBackoffMs + baseIntervalMs;
  const cooldownUntil = new Date(nowMs + cooldownMs).toISOString();

  await db.update(schema.routeChannels).set({
    failCount,
    lastFailAt: nowIso,
    consecutiveFailCount,
    cooldownUntil,
    cooldownLevel: 0,
  }).where(eq(schema.routeChannels.id, normalizedChannelId)).run();

  patchCachedChannel(normalizedChannelId, (channel) => {
    channel.failCount = failCount;
    channel.lastFailAt = nowIso;
    channel.consecutiveFailCount = consecutiveFailCount;
    channel.cooldownUntil = cooldownUntil;
    channel.cooldownLevel = 0;
  });

  // 探测失败不应触发站点级 runtime health 惩罚（那是给真实流量失败用的，
  // 会连带降权同站点其他健康渠道）；只失效路由缓存让新冷却生效。
  invalidateRouteScopedCache(route.id);
}

/**
 * Clear persisted failure and cooldown state for the given channels.
 */
export async function clearChannelFailureState(channelIds: number[]): Promise<number> {
  const normalizedChannelIds = Array.from(new Set(
    channelIds
      .filter((channelId): channelId is number => Number.isFinite(channelId) && channelId > 0)
      .map((channelId) => Math.trunc(channelId)),
  ));
  if (normalizedChannelIds.length === 0) return 0;

  await ensureSiteRuntimeHealthStateLoaded();
  const runtimeHealthRows = await db.select({
    siteId: schema.accounts.siteId,
    accountId: schema.routeChannels.accountId,
    tokenId: schema.routeChannels.tokenId,
    sourceModel: schema.routeChannels.sourceModel,
    routeModelPattern: schema.tokenRoutes.modelPattern,
  }).from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .where(inArray(schema.routeChannels.id, normalizedChannelIds))
    .all();

  const result = await db.update(schema.routeChannels).set({
    failCount: 0,
    lastFailAt: null,
    consecutiveFailCount: 0,
    cooldownLevel: 0,
    cooldownUntil: null,
  }).where(inArray(schema.routeChannels.id, normalizedChannelIds)).run();

  // Manual cooldown clearing means "allow a fresh attempt", not "proven
  // healthy". Reset only matching false connectivity evidence to unknown so
  // the channel can re-enter selection without fabricating a successful probe.
  const accountModels = new Map<number, Set<string>>();
  const tokenModels = new Map<number, Set<string>>();
  for (const row of runtimeHealthRows) {
    const modelNames = [row.sourceModel, row.routeModelPattern]
      .map((value) => String(value || '').trim())
      .filter((value) => value && !value.toLowerCase().startsWith('re:') && !/[?*]/.test(value));
    if (modelNames.length === 0) continue;
    if (!accountModels.has(row.accountId)) accountModels.set(row.accountId, new Set());
    for (const modelName of modelNames) accountModels.get(row.accountId)!.add(modelName);
    if (typeof row.tokenId === 'number' && row.tokenId > 0) {
      if (!tokenModels.has(row.tokenId)) tokenModels.set(row.tokenId, new Set());
      for (const modelName of modelNames) tokenModels.get(row.tokenId)!.add(modelName);
    }
  }
  // One transaction for the whole sweep: the statement count is unchanged (each
  // account needs its own model list) but SQLite commits and fsyncs once instead
  // of once per account, which dominates when clearing a large batch.
  await db.transaction(async (tx: any) => {
    for (const [accountId, modelNames] of accountModels) {
      await tx.update(schema.modelAvailability)
        .set({ connectivity: null })
        .where(and(
          eq(schema.modelAvailability.accountId, accountId),
          eq(schema.modelAvailability.connectivity, false),
          inArray(sql<string>`lower(trim(${schema.modelAvailability.modelName}))`, [...modelNames].map((name) => name.toLowerCase())),
        ))
        .run();
    }
    for (const [tokenId, modelNames] of tokenModels) {
      await tx.update(schema.tokenModelAvailability)
        .set({ connectivity: null })
        .where(and(
          eq(schema.tokenModelAvailability.tokenId, tokenId),
          eq(schema.tokenModelAvailability.connectivity, false),
          inArray(sql<string>`lower(trim(${schema.tokenModelAvailability.modelName}))`, [...modelNames].map((name) => name.toLowerCase())),
        ))
        .run();
    }
  });

  if (clearRuntimeHealthStatesForChannels(runtimeHealthRows)) {
    await persistSiteRuntimeHealthState();
  }

  invalidateTokenRouterCache();
  return Number(result?.changes || normalizedChannelIds.length);
}

/**
 * Record failure and set cooldown.
 */
export async function recordFailure(
  channelId: number,
  context: SiteRuntimeFailureContext | string | null = {},
  actualAccountId?: number,
) {
  await ensureSiteRuntimeHealthStateLoaded();
  const row = await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .where(eq(schema.routeChannels.id, channelId))
    .get();
  if (!row) return;

  const ch = row.route_channels;
  const account = row.accounts;
  const route = row.token_routes;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const normalizedContext: SiteRuntimeFailureContext = typeof context === 'string'
    ? { modelName: context }
    : (context ?? {});
  if (typeof ch.oauthRouteUnitId === 'number' && ch.oauthRouteUnitId > 0) {
    const targetAccountId = Number.isFinite(actualAccountId) && (actualAccountId ?? 0) > 0
      ? Math.trunc(actualAccountId!)
      : account.id;
    const memberRow = await db.select({
      member: schema.oauthRouteUnitMembers,
      account: schema.accounts,
      unit: schema.oauthRouteUnits,
    }).from(schema.oauthRouteUnitMembers)
      .innerJoin(schema.accounts, eq(schema.oauthRouteUnitMembers.accountId, schema.accounts.id))
      .innerJoin(schema.oauthRouteUnits, eq(schema.oauthRouteUnitMembers.unitId, schema.oauthRouteUnits.id))
      .where(and(
        eq(schema.oauthRouteUnitMembers.unitId, ch.oauthRouteUnitId),
        eq(schema.oauthRouteUnitMembers.accountId, targetAccountId),
      ))
      .get();
    if (memberRow) {
      const shortWindowLimitCooldownUntil = resolveShortWindowLimitCooldown(memberRow.account, normalizedContext, nowMs);
      const failCount = shortWindowLimitCooldownUntil ? 0 : ((memberRow.member.failCount ?? 0) + 1);
      const routeUnitStrategy = memberRow.unit.strategy === 'stick_until_unavailable'
        ? 'stick_until_unavailable'
        : 'round_robin';
      let cooldownUntil: string | null = null;
      let consecutiveFailCount = Math.max(0, memberRow.member.consecutiveFailCount ?? 0) + 1;
      let cooldownLevel = Math.max(0, memberRow.member.cooldownLevel ?? 0);

      const cooldownPolicy = resolveFailureCooldownWeight(normalizedContext);
      if (shortWindowLimitCooldownUntil) {
        cooldownUntil = shortWindowLimitCooldownUntil;
        consecutiveFailCount = 0;
        cooldownLevel = 0;
      } else if (cooldownPolicy.skipCooldown) {
        cooldownUntil = null;
        consecutiveFailCount = 0;
        cooldownLevel = 0;
      } else if (routeUnitStrategy === 'round_robin') {
        if (consecutiveFailCount >= ROUND_ROBIN_FAILURE_THRESHOLD) {
          cooldownLevel = Math.min(cooldownLevel + 1, ROUND_ROBIN_COOLDOWN_LEVELS_SEC.length - 1);
          const cooldownSec = resolveRoundRobinCooldownSec(cooldownLevel);
          cooldownUntil = cooldownSec > 0
            ? new Date(nowMs + clampFailureCooldownMs(cooldownSec * 1000 * cooldownPolicy.weight)).toISOString()
            : null;
          consecutiveFailCount = 0;
        }
      } else {
        const failureDecision = classifyProxyFailure(normalizedContext);
        if (failureDecision.class === 'endpoint_pool_down') {
          // Align with the endpoint pool cooldown (see the non-oauth branch).
          cooldownUntil = new Date(nowMs + SITE_API_ENDPOINT_COOLDOWN_MS).toISOString();
        } else {
          cooldownUntil = new Date(nowMs + resolveEffectiveFailureCooldownMs(failCount, cooldownPolicy.weight)).toISOString();
        }
        consecutiveFailCount = 0;
        cooldownLevel = 0;
      }

      await db.update(schema.oauthRouteUnitMembers).set({
        failCount,
        lastFailAt: nowIso,
        consecutiveFailCount,
        cooldownLevel,
        cooldownUntil,
        updatedAt: nowIso,
      }).where(eq(schema.oauthRouteUnitMembers.id, memberRow.member.id)).run();
      recordSiteRuntimeFailure(memberRow.account.siteId, normalizedContext, nowMs);
      invalidateRouteScopedCache(route.id);
      return;
    }
  }

  const shortWindowLimitCooldownUntil = resolveShortWindowLimitCooldown(account, normalizedContext, nowMs);
  const failCount = shortWindowLimitCooldownUntil ? 0 : ((ch.failCount ?? 0) + 1);
  const routeStrategy = resolveRouteStrategy(route);
  const affectedChannelIds = shortWindowLimitCooldownUntil
    ? await loadCredentialScopedChannelIds(ch, account.id)
    : [channelId];
  let cooldownUntil: string | null = null;
  let consecutiveFailCount = Math.max(0, ch.consecutiveFailCount ?? 0) + 1;
  let cooldownLevel = Math.max(0, ch.cooldownLevel ?? 0);

  const cooldownPolicy = resolveFailureCooldownWeight(normalizedContext);
  if (shortWindowLimitCooldownUntil) {
    cooldownUntil = shortWindowLimitCooldownUntil;
    consecutiveFailCount = 0;
    cooldownLevel = 0;
  } else if (cooldownPolicy.skipCooldown) {
    cooldownUntil = null;
    consecutiveFailCount = 0;
    cooldownLevel = 0;
  } else if (routeStrategy === 'round_robin') {
    if (consecutiveFailCount >= ROUND_ROBIN_FAILURE_THRESHOLD) {
      cooldownLevel = Math.min(cooldownLevel + 1, ROUND_ROBIN_COOLDOWN_LEVELS_SEC.length - 1);
      const cooldownSec = resolveRoundRobinCooldownSec(cooldownLevel);
      cooldownUntil = cooldownSec > 0
        ? new Date(nowMs + clampFailureCooldownMs(cooldownSec * 1000 * cooldownPolicy.weight)).toISOString()
        : null;
      consecutiveFailCount = 0;
    }
  } else {
    const failureDecision = classifyProxyFailure(normalizedContext);
    if (failureDecision.class === 'endpoint_pool_down') {
      // Every API endpoint for this site is in cooldown. The channel-level
      // backoff must align with the endpoint pool cooldown (5 min) instead
      // of the short fibonacci backoff, otherwise the router keeps picking
      // the site after 15s while its endpoints are still cooling down and
      // every pick fails in ~1ms (endpoint_all_down). Reusing the endpoint
      // cooldown constant keeps both systems in sync without extra state.
      cooldownUntil = new Date(nowMs + SITE_API_ENDPOINT_COOLDOWN_MS).toISOString();
    } else {
      cooldownUntil = new Date(nowMs + resolveEffectiveFailureCooldownMs(failCount, cooldownPolicy.weight)).toISOString();
    }
    consecutiveFailCount = 0;
    cooldownLevel = 0;
  }

  await db.update(schema.routeChannels).set({
    failCount,
    lastFailAt: nowIso,
    consecutiveFailCount,
    cooldownLevel,
    cooldownUntil,
  }).where(inArray(schema.routeChannels.id, affectedChannelIds)).run();

  for (const affectedChannelId of affectedChannelIds) {
    patchCachedChannel(affectedChannelId, (channel) => {
      channel.failCount = failCount;
      channel.lastFailAt = nowIso;
      channel.cooldownUntil = cooldownUntil;
      channel.consecutiveFailCount = consecutiveFailCount;
      channel.cooldownLevel = cooldownLevel;
    });
  }

  recordSiteRuntimeFailure(account.siteId, normalizedContext, nowMs);

  // Quota/credit exhaustion (402 / "insufficient quota" / "用户剩余额度"):
  // the stored balance snapshot is hourly and stale by the time the upstream
  // refuses a request, so each call keeps burning into a near-empty account.
  // Mark the balance as exhausted immediately (session accounts) so scoring
  // hard-excludes it, then re-verify asynchronously — a successful refresh
  // restores the real balance and un-excludes; a failing one keeps it out
  // until the hourly sweep proves otherwise.
  const failureDecision = classifyProxyFailure(normalizedContext);
  if (config.routeQuotaExhaustionExclude !== false && failureDecision.class === 'quota_or_credit') {
    const credentialMode = getCredentialModeFromExtraConfig(account.extraConfig);
    const looksLikeDirectApiKey = credentialMode === 'apikey'
      || (!!account.apiToken && !account.accessToken);
    if (!looksLikeDirectApiKey) {
      await db.update(schema.accounts).set({
        balance: 0,
        updatedAt: new Date(nowMs).toISOString(),
      }).where(eq(schema.accounts.id, account.id)).run();
      // Re-verify in the background; never throw into the request path.
      void refreshBalance(account.id).catch(() => {});
    }
    // Park the channel the same way recordProbeFailure does for a probe that
    // discovers exhaustion: failCount/consecutiveFailCount/cooldownLevel all
    // zero plus a long cooldownUntil, which isProviderDirectedCooldown reads
    // as "the provider parked this, probing cannot heal it". Only the probe
    // path used to write that shape, so a REAL request that hit exhaustion
    // left behind an ordinary fibonacci cooldown: the channel stayed in the
    // recovery-probe pool and kept taking traffic until a probe happened to
    // rediscover the same exhaustion. Exhaustion is upstream-side state — a
    // recharge or an operator is the only thing that clears it — so both
    // paths must reach the same verdict.
    const providerCooldownUntil = new Date(nowMs + QUOTA_EXHAUSTED_COOLDOWN_MS).toISOString();
    await db.update(schema.routeChannels).set({
      failCount: 0,
      lastFailAt: nowIso,
      consecutiveFailCount: 0,
      cooldownUntil: providerCooldownUntil,
      cooldownLevel: 0,
    }).where(inArray(schema.routeChannels.id, affectedChannelIds)).run();
    for (const affectedChannelId of affectedChannelIds) {
      patchCachedChannel(affectedChannelId, (channel) => {
        channel.failCount = 0;
        channel.lastFailAt = nowIso;
        channel.consecutiveFailCount = 0;
        channel.cooldownUntil = providerCooldownUntil;
        channel.cooldownLevel = 0;
      });
    }
    invalidateRouteScopedCache(route.id);
  }
}

/**
 * Clear failure cooldown state for a channel (failCount / lastFailAt /
 * cooldownUntil / consecutiveFailCount / cooldownLevel). Used by the proxy
 * recovery pass: after a burst of transient failures (403/429/5xx) the
 * last-success channel deserves one retry instead of being parked in
 * backoff for the full cooldown window.
 */
export async function clearFailureCooldown(channelId: number): Promise<void> {
  const normalizedChannelId = Math.trunc(channelId || 0);
  if (normalizedChannelId <= 0) return;

  const channelRow = await db.select({
    routeId: schema.routeChannels.routeId,
    oauthRouteUnitId: schema.routeChannels.oauthRouteUnitId,
  }).from(schema.routeChannels)
    .where(eq(schema.routeChannels.id, normalizedChannelId))
    .get();
  if (!channelRow) return;

  const clearedState = {
    failCount: 0,
    lastFailAt: null,
    cooldownUntil: null,
    consecutiveFailCount: 0,
    cooldownLevel: 0,
  };
  await db.update(schema.routeChannels).set(clearedState)
    .where(eq(schema.routeChannels.id, normalizedChannelId)).run();

  if (typeof channelRow.oauthRouteUnitId === 'number' && channelRow.oauthRouteUnitId > 0) {
    await db.update(schema.oauthRouteUnitMembers).set({
      ...clearedState,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.oauthRouteUnitMembers.unitId, channelRow.oauthRouteUnitId)).run();
  }

  patchCachedChannel(normalizedChannelId, (channel) => {
    Object.assign(channel, clearedState);
  });
  invalidateRouteScopedCache(channelRow.routeId);
}
