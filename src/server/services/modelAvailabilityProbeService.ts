import { and, asc, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { startBackgroundTask } from './backgroundTaskService.js';
import { isUsableAccountToken, ACCOUNT_TOKEN_VALUE_STATUS_READY } from './accountTokenService.js';
import { probeRuntimeModel } from './runtimeModelProbe.js';
import * as routeRefreshWorkflow from './routeRefreshWorkflow.js';

type ProbeStatus = 'supported' | 'unsupported' | 'inconclusive' | 'skipped';

type ProbeAccountTarget = {
  kind: 'account';
  rowId: number;
  modelName: string;
  lastKnownAvailable: boolean;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
};

type ProbeTokenTarget = {
  kind: 'token';
  rowId: number;
  tokenId: number;
  modelName: string;
  tokenValue: string;
  lastKnownAvailable: boolean;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
};

type ProbeTarget = ProbeAccountTarget | ProbeTokenTarget;
type ProbeAccountContext = {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
};

export type ModelAvailabilityProbeAccountResult = {
  accountId: number;
  siteId: number;
  status: 'success' | 'failed' | 'skipped';
  scanned: number;
  supported: number;
  unsupported: number;
  inconclusive: number;
  skipped: number;
  updatedRows: number;
  message: string;
};

export type ModelAvailabilityProbeExecutionResult = {
  results: ModelAvailabilityProbeAccountResult[];
  summary: {
    totalAccounts: number;
    success: number;
    failed: number;
    skipped: number;
    scanned: number;
    supported: number;
    unsupported: number;
    inconclusive: number;
    skippedModels: number;
    updatedRows: number;
    rebuiltRoutes: boolean;
  };
};

let probeSchedulerTimer: ReturnType<typeof setInterval> | null = null;
const probeAccountLeases = new Set<number>();

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, Math.trunc(concurrency || 1)));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex] as T, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
  return results;
}

async function probeSingleTarget(target: ProbeTarget): Promise<{
  status: ProbeStatus;
  latencyMs: number | null;
  reason: string;
}> {
  return await probeRuntimeModel({
    site: target.site,
    account: target.account,
    modelName: target.modelName,
    timeoutMs: config.modelAvailabilityProbeTimeoutMs,
    tokenValue: target.kind === 'token' ? target.tokenValue : undefined,
  });
}

async function updateProbeRow(target: ProbeTarget, status: ProbeStatus, latencyMs: number | null): Promise<{
  touched: boolean;
  availabilityChanged: boolean;
}> {
  if (status === 'inconclusive' || status === 'skipped') {
    return {
      touched: false,
      availabilityChanged: false,
    };
  }
  const nextAvailable = status === 'supported';
  const patch = {
    available: nextAvailable,
    latencyMs,
    checkedAt: new Date().toISOString(),
  };

  if (target.kind === 'account') {
    await db.update(schema.modelAvailability)
      .set(patch)
      .where(eq(schema.modelAvailability.id, target.rowId))
      .run();
    return {
      touched: true,
      availabilityChanged: target.lastKnownAvailable !== nextAvailable,
    };
  }

  await db.update(schema.tokenModelAvailability)
    .set(patch)
    .where(eq(schema.tokenModelAvailability.id, target.rowId))
    .run();
  return {
    touched: true,
    availabilityChanged: target.lastKnownAvailable !== nextAvailable,
  };
}

async function loadActiveProbeAccountContext(accountId: number): Promise<ProbeAccountContext | null> {
  const accountRow = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!accountRow) return null;
  if ((accountRow.accounts.status || 'active') !== 'active') return null;
  if ((accountRow.sites.status || 'active') !== 'active') return null;
  return {
    account: accountRow.accounts,
    site: accountRow.sites,
  };
}

async function loadProbeTargetsForAccount(context: ProbeAccountContext): Promise<ProbeTarget[]> {
  const targets: ProbeTarget[] = [];
  const accountModels = await db.select()
    .from(schema.modelAvailability)
    .where(eq(schema.modelAvailability.accountId, context.account.id))
    .orderBy(asc(schema.modelAvailability.checkedAt))
    .all();
  for (const row of accountModels) {
    if (row.isManual) continue;
    targets.push({
      kind: 'account',
      rowId: row.id,
      modelName: row.modelName,
      lastKnownAvailable: !!row.available,
      account: context.account,
      site: context.site,
    });
  }

  const tokenRows = await db.select()
    .from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .where(and(
      eq(schema.accountTokens.accountId, context.account.id),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
    ))
    .orderBy(asc(schema.tokenModelAvailability.checkedAt))
    .all();
  for (const row of tokenRows) {
    if (!isUsableAccountToken(row.account_tokens)) continue;
    const tokenValue = String(row.account_tokens.token || '').trim();
    if (!tokenValue) continue;
    targets.push({
      kind: 'token',
      rowId: row.token_model_availability.id,
      tokenId: row.account_tokens.id,
      modelName: row.token_model_availability.modelName,
      tokenValue,
      lastKnownAvailable: !!row.token_model_availability.available,
      account: context.account,
      site: context.site,
    });
  }

  return targets;
}

function tryAcquireProbeAccountLease(accountId: number): boolean {
  if (!Number.isFinite(accountId) || accountId <= 0) return false;
  if (probeAccountLeases.has(accountId)) return false;
  probeAccountLeases.add(accountId);
  return true;
}

function releaseProbeAccountLease(accountId: number): void {
  probeAccountLeases.delete(accountId);
}

function buildSkippedProbeAccountResult(input: {
  accountId: number;
  siteId: number;
  message: string;
}): ModelAvailabilityProbeAccountResult {
  return {
    accountId: input.accountId,
    siteId: input.siteId,
    status: 'skipped',
    scanned: 0,
    supported: 0,
    unsupported: 0,
    inconclusive: 0,
    skipped: 0,
    updatedRows: 0,
    message: input.message,
  };
}

function summarizeProbeResults(results: ModelAvailabilityProbeAccountResult[], rebuiltRoutes: boolean): ModelAvailabilityProbeExecutionResult {
  return {
    results,
    summary: {
      totalAccounts: results.length,
      success: results.filter((item) => item.status === 'success').length,
      failed: results.filter((item) => item.status === 'failed').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      scanned: results.reduce((sum, item) => sum + item.scanned, 0),
      supported: results.reduce((sum, item) => sum + item.supported, 0),
      unsupported: results.reduce((sum, item) => sum + item.unsupported, 0),
      inconclusive: results.reduce((sum, item) => sum + item.inconclusive, 0),
      skippedModels: results.reduce((sum, item) => sum + item.skipped, 0),
      updatedRows: results.reduce((sum, item) => sum + item.updatedRows, 0),
      rebuiltRoutes,
    },
  };
}

export async function executeModelAvailabilityProbe(input: {
  accountId?: number;
  rebuildRoutes?: boolean;
} = {}): Promise<ModelAvailabilityProbeExecutionResult> {
  if (!config.modelAvailabilityProbeAllow || !config.modelAvailabilityProbeEnabled) {
    return summarizeProbeResults([], false);
  }
  const accountIds = input.accountId
    ? [input.accountId]
    : (await db.select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.status, 'active'))
      .all()).map((row) => row.id);

  const results: ModelAvailabilityProbeAccountResult[] = [];
  let shouldRebuildRoutes = false;

  for (const accountId of accountIds) {
    const context = await loadActiveProbeAccountContext(accountId);
    if (!context) {
      continue;
    }
    if (!tryAcquireProbeAccountLease(accountId)) {
      results.push(buildSkippedProbeAccountResult({
        accountId,
        siteId: context.site.id,
        message: 'model availability probe already running for account',
      }));
      continue;
    }

    try {
      const targets = await loadProbeTargetsForAccount(context);
      if (targets.length <= 0) {
        results.push(buildSkippedProbeAccountResult({
          accountId,
          siteId: context.site.id,
          message: 'no discovered models to probe',
        }));
        continue;
      }

      let supported = 0;
      let unsupported = 0;
      let inconclusive = 0;
      let skipped = 0;
      let updatedRows = 0;
      let failed = false;

      const probeOutcomes = await mapWithConcurrency(
        targets,
        config.modelAvailabilityProbeConcurrency,
        async (target) => {
          try {
            const probe = await probeSingleTarget(target);
            const update = await updateProbeRow(target, probe.status, probe.latencyMs);
            return {
              target,
              probe,
              touched: update.touched,
              availabilityChanged: update.availabilityChanged,
              failed: false,
            };
          } catch (error) {
            console.warn(`[model-probe] account ${accountId} model ${target.modelName} probe failed`, error);
            return {
              target,
              probe: {
                status: 'inconclusive' as const,
                latencyMs: null,
                reason: error instanceof Error ? error.message : 'probe failed',
              },
              touched: false,
              availabilityChanged: false,
              failed: true,
            };
          }
        },
      );

      for (const outcome of probeOutcomes) {
        if (outcome.probe.status === 'supported') supported += 1;
        if (outcome.probe.status === 'unsupported') unsupported += 1;
        if (outcome.probe.status === 'inconclusive') inconclusive += 1;
        if (outcome.probe.status === 'skipped') skipped += 1;
        if (outcome.touched) {
          updatedRows += 1;
        }
        if (outcome.availabilityChanged) {
          shouldRebuildRoutes = true;
        }
        if (outcome.failed) {
          failed = true;
        }
      }

      results.push({
        accountId,
        siteId: context.site.id,
        status: failed ? 'failed' : 'success',
        scanned: targets.length,
        supported,
        unsupported,
        inconclusive,
        skipped,
        updatedRows,
        message: failed
          ? 'model availability probe finished with partial failures'
          : 'model availability probe finished',
      });
    } finally {
      releaseProbeAccountLease(accountId);
    }
  }

  let rebuiltRoutes = false;
  if (input.rebuildRoutes !== false && shouldRebuildRoutes) {
    await routeRefreshWorkflow.rebuildRoutesOnly();
    rebuiltRoutes = true;
  }

  return summarizeProbeResults(results, rebuiltRoutes);
}

export function buildModelAvailabilityProbeTaskDedupeKey(accountId?: number | null): string {
  const normalizedAccountId = Number.isFinite(accountId as number) && Number(accountId) > 0
    ? Math.trunc(Number(accountId))
    : null;
  return normalizedAccountId
    ? `model-availability-probe-${normalizedAccountId}`
    : 'model-availability-probe-all';
}

export function queueModelAvailabilityProbeTask(input: {
  accountId?: number;
  title?: string;
}) {
  const accountId = Number.isFinite(input.accountId as number) ? Math.trunc(input.accountId as number) : null;
  const title = input.title || (accountId
    ? `探测模型可用性 #${accountId}`
    : '探测模型可用性');
  const dedupeKey = buildModelAvailabilityProbeTaskDedupeKey(accountId);

  return startBackgroundTask(
    {
      type: 'model-probe',
      title,
      dedupeKey,
      notifyOnFailure: true,
      successMessage: (currentTask) => {
        const summary = (currentTask.result as ModelAvailabilityProbeExecutionResult | undefined)?.summary;
        if (!summary) return `${title}已完成`;
        return `${title}完成：探测 ${summary.scanned}，可用 ${summary.supported}，不可用 ${summary.unsupported}，不确定 ${summary.inconclusive}`;
      },
      failureMessage: (currentTask) => `${title}失败：${currentTask.error || 'unknown error'}`,
    },
    async () => executeModelAvailabilityProbe({
      accountId: accountId ?? undefined,
      rebuildRoutes: true,
    }),
  );
}

export function startModelAvailabilityProbeScheduler(intervalMs = config.modelAvailabilityProbeIntervalMs) {
  stopModelAvailabilityProbeScheduler();
  if (!config.modelAvailabilityProbeAllow || !config.modelAvailabilityProbeEnabled) {
    return {
      enabled: false,
      intervalMs: 0,
    };
  }

  const safeIntervalMs = Math.max(60_000, Math.trunc(intervalMs || 0));
  probeSchedulerTimer = setInterval(() => {
    void queueModelAvailabilityProbeTask({
      title: '后台模型可用性探测',
    });
  }, safeIntervalMs);
  probeSchedulerTimer.unref?.();
  return {
    enabled: true,
    intervalMs: safeIntervalMs,
  };
}

export function stopModelAvailabilityProbeScheduler() {
  if (probeSchedulerTimer) {
    clearInterval(probeSchedulerTimer);
    probeSchedulerTimer = null;
  }
}

export function __resetModelAvailabilityProbeExecutionStateForTests(): void {
  probeAccountLeases.clear();
}

export type SingleModelProbeResult = {
  modelName: string;
  ok: boolean;
  status: 'supported' | 'unsupported' | 'inconclusive' | 'skipped' | 'not_found';
  latencyMs: number | null;
  reason: string;
  accountId: number | null;
  siteId: number | null;
  siteName: string | null;
  username: string | null;
};

export type MarketplaceModelProbeOptions = {
  siteId?: number | null;
  accountId?: number | null;
};

export type MarketplaceModelProbeResponse = {
  modelName: string;
  ok: boolean;
  status: 'supported' | 'unsupported' | 'inconclusive' | 'skipped' | 'not_found' | 'mixed';
  latencyMs: number | null;
  reason: string;
  accountId: number | null;
  siteId: number | null;
  siteName: string | null;
  username: string | null;
  summary: {
    total: number;
    supported: number;
    unsupported: number;
    inconclusive: number;
    skipped: number;
    notFound: number;
  };
  results: SingleModelProbeResult[];
};

type MarketplaceProbeTarget = {
  accountRowId: number | null;
  tokenRowId: number | null;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  tokenValue?: string;
};

async function resolvePreferredTokenValue(accountId: number): Promise<string | undefined> {
  try {
    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(and(
        eq(schema.accountTokens.accountId, accountId),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      ))
      .orderBy(asc(schema.accountTokens.id))
      .all();
    const preferredToken = tokenRows.find((row) => isUsableAccountToken(row) && String(row.token || '').trim());
    if (preferredToken) return String(preferredToken.token || '').trim();
  } catch {
    // ignore and fall back to account credentials
  }
  return undefined;
}

function summarizeMarketplaceProbeResults(
  modelName: string,
  results: SingleModelProbeResult[],
): MarketplaceModelProbeResponse {
  const summary = {
    total: results.length,
    supported: results.filter((item) => item.status === 'supported').length,
    unsupported: results.filter((item) => item.status === 'unsupported').length,
    inconclusive: results.filter((item) => item.status === 'inconclusive').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    notFound: results.filter((item) => item.status === 'not_found').length,
  };

  if (results.length === 0) {
    return {
      modelName,
      ok: false,
      status: 'not_found',
      latencyMs: null,
      reason: 'no active account/token currently lists this model',
      accountId: null,
      siteId: null,
      siteName: null,
      username: null,
      summary,
      results,
    };
  }

  const supported = results.filter((item) => item.status === 'supported');
  const primary = supported[0] || results[0]!;
  let status: MarketplaceModelProbeResponse['status'] = primary.status;
  if (supported.length > 0 && supported.length < results.length) {
    status = 'mixed';
  } else if (supported.length === results.length) {
    status = 'supported';
  } else if (results.every((item) => item.status === 'unsupported')) {
    status = 'unsupported';
  } else if (results.every((item) => item.status === 'skipped')) {
    status = 'skipped';
  } else if (results.every((item) => item.status === 'not_found')) {
    status = 'not_found';
  } else if (supported.length === 0) {
    status = 'inconclusive';
  }

  const latencyValues = supported
    .map((item) => item.latencyMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const latencyMs = latencyValues.length > 0
    ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length)
    : primary.latencyMs;

  return {
    modelName,
    ok: supported.length > 0,
    status,
    latencyMs,
    reason: supported.length > 0
      ? `supported ${summary.supported}/${summary.total}`
      : (primary.reason || status),
    accountId: primary.accountId,
    siteId: primary.siteId,
    siteName: primary.siteName,
    username: primary.username,
    summary,
    results,
  };
}

/**
 * On-demand marketplace probe.
 * - model-level: probe all active accounts that list the model
 * - optional siteId/accountId: restrict to one supplier/account
 * Does NOT require batch probe to be enabled.
 */
export async function probeSingleModelAvailability(
  modelName: string,
  options: MarketplaceModelProbeOptions = {},
): Promise<MarketplaceModelProbeResponse> {
  const normalized = String(modelName || '').trim();
  if (!normalized) {
    return summarizeMarketplaceProbeResults('', []);
  }

  const siteId = Number.isFinite(options.siteId as number) && Number(options.siteId) > 0
    ? Math.trunc(Number(options.siteId))
    : null;
  const accountId = Number.isFinite(options.accountId as number) && Number(options.accountId) > 0
    ? Math.trunc(Number(options.accountId))
    : null;

  const accountHits = await db.select({
    rowId: schema.modelAvailability.id,
    modelName: schema.modelAvailability.modelName,
    available: schema.modelAvailability.available,
    account: schema.accounts,
    site: schema.sites,
  })
    .from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.modelAvailability.modelName, normalized),
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
      ...(accountId ? [eq(schema.accounts.id, accountId)] : []),
      ...(siteId ? [eq(schema.sites.id, siteId)] : []),
    ))
    .orderBy(asc(schema.sites.id), asc(schema.accounts.id))
    .all();

  const targetsByAccount = new Map<number, MarketplaceProbeTarget>();
  for (const hit of accountHits) {
    if (targetsByAccount.has(hit.account.id)) continue;
    targetsByAccount.set(hit.account.id, {
      accountRowId: hit.rowId,
      tokenRowId: null,
      account: hit.account,
      site: hit.site,
    });
  }

  // Also include token-level availability for accounts not already covered.
  const tokenHits = await db.select({
    rowId: schema.tokenModelAvailability.id,
    modelName: schema.tokenModelAvailability.modelName,
    available: schema.tokenModelAvailability.available,
    token: schema.accountTokens,
    account: schema.accounts,
    site: schema.sites,
  })
    .from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.tokenModelAvailability.modelName, normalized),
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      ...(accountId ? [eq(schema.accounts.id, accountId)] : []),
      ...(siteId ? [eq(schema.sites.id, siteId)] : []),
    ))
    .orderBy(asc(schema.sites.id), asc(schema.accounts.id))
    .all();

  for (const hit of tokenHits) {
    if (!isUsableAccountToken(hit.token)) continue;
    if (targetsByAccount.has(hit.account.id)) {
      const existing = targetsByAccount.get(hit.account.id)!;
      if (!existing.tokenValue) {
        existing.tokenValue = String(hit.token.token || '').trim() || undefined;
        existing.tokenRowId = hit.rowId;
      }
      continue;
    }
    targetsByAccount.set(hit.account.id, {
      accountRowId: null,
      tokenRowId: hit.rowId,
      account: hit.account,
      site: hit.site,
      tokenValue: String(hit.token.token || '').trim() || undefined,
    });
  }

  const targets = [...targetsByAccount.values()];
  if (targets.length === 0) {
    return summarizeMarketplaceProbeResults(normalized, []);
  }

  const results = await mapWithConcurrency(targets, 2, async (target) => {
    const tokenValue = target.tokenValue || await resolvePreferredTokenValue(target.account.id);
    const probe = await probeRuntimeModel({
      site: target.site,
      account: target.account,
      modelName: normalized,
      timeoutMs: config.modelAvailabilityProbeTimeoutMs,
      tokenValue,
    });

    if (probe.status === 'supported' || probe.status === 'unsupported') {
      const checkedAt = new Date().toISOString();
      if (target.accountRowId != null) {
        await db.update(schema.modelAvailability)
          .set({
            available: probe.status === 'supported',
            latencyMs: probe.latencyMs,
            checkedAt,
          })
          .where(eq(schema.modelAvailability.id, target.accountRowId))
          .run();
      }
      if (target.tokenRowId != null) {
        await db.update(schema.tokenModelAvailability)
          .set({
            available: probe.status === 'supported',
            latencyMs: probe.latencyMs,
            checkedAt,
          })
          .where(eq(schema.tokenModelAvailability.id, target.tokenRowId))
          .run();
      }
    }

    return {
      modelName: normalized,
      ok: probe.status === 'supported',
      status: probe.status,
      latencyMs: probe.latencyMs,
      reason: probe.reason,
      accountId: target.account.id,
      siteId: target.site.id,
      siteName: target.site.name,
      username: target.account.username,
    } satisfies SingleModelProbeResult;
  });

  return summarizeMarketplaceProbeResults(normalized, results);
}
