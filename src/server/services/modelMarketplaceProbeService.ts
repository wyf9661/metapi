import {and, asc, count, eq} from 'drizzle-orm';
import { canonicalizeModelName } from '../shared/modelCanonicalization.js';
import { resolveModelAvailabilityProbeTimeoutMs } from '../config.js';
import { db, schema } from '../db/index.js';
import { isUsableAccountToken, ACCOUNT_TOKEN_VALUE_STATUS_READY } from './accountTokenService.js';
import { probeRuntimeModel } from './runtimeModelProbe.js';
import { isModelDisabledForSite, loadSiteDisabledModelsIndex } from './siteDisabledModels.js';

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(concurrency, items.length))).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
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
  /** The model spelling actually discovered from this upstream account/token. */
  upstreamModelName: string;
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
    const preferredToken = tokenRows.find((row: any) => isUsableAccountToken(row) && String(row.token || '').trim());
    if (preferredToken) return String(preferredToken.token || '').trim();
  } catch {
    // ignore and fall back to account credentials
  }
  return undefined;
}



async function diagnoseNoProbeTargets(
  modelName: string,
  options: MarketplaceModelProbeOptions,
): Promise<string> {
  const siteId = Number.isFinite(options.siteId as number) && Number(options.siteId) > 0
    ? Math.trunc(Number(options.siteId))
    : null;
  const accountId = Number.isFinite(options.accountId as number) && Number(options.accountId) > 0
    ? Math.trunc(Number(options.accountId))
    : null;
  const canonicalModel = canonicalizeModelName(modelName) || modelName.toLowerCase();

  // 1. Fetch all rows within site/account scope, then match by canonical name in JS
  const allScopedRows = await db.select({
    id: schema.modelAvailability.id,
    modelName: schema.modelAvailability.modelName,
    siteId: schema.sites.id,
    siteName: schema.sites.name,
    siteStatus: schema.sites.status,
    accountId: schema.accounts.id,
    accountStatus: schema.accounts.status,
  })
    .from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      ...(accountId ? [eq(schema.accounts.id, accountId)] : []),
      ...(siteId ? [eq(schema.sites.id, siteId)] : []),
    ))
    .all();

  const matchingRows = allScopedRows.filter((row: any) => {
    const dbCanonical = canonicalizeModelName(row.modelName) || row.modelName.toLowerCase();
    return dbCanonical === canonicalModel;
  });
  const scopedTotal = matchingRows.length;

  if (scopedTotal === 0) {
    // No rows in scope — check if ANY model_availability row exists for this canonical name
    const allRows = await db.select({
      modelName: schema.modelAvailability.modelName,
    })
      .from(schema.modelAvailability)
      .all() as Array<{ modelName: string }>;
    const globalMatching = allRows.filter((row) => {
      const dbCanonical = canonicalizeModelName(row.modelName) || row.modelName.toLowerCase();
      return dbCanonical === canonicalModel;
    });
    const globalCount = globalMatching.length;

    if (globalCount === 0) {
      // Model not found at all — check total and suggest similar
      const totalMa = await db.select({ count: count() }).from(schema.modelAvailability).get();
      if (!totalMa || totalMa.count === 0) {
        return '模型列表为空，没有任何站点同步过模型数据。请先添加站点并同步模型。';
      }
      // Find similar canonical names
      const allUniqueNames = [...new Set(allRows.map(r => r.modelName))];
      const similar = allUniqueNames.filter((name) => {
        const c = canonicalizeModelName(name) || name.toLowerCase();
        return c !== canonicalModel && (c.includes(canonicalModel) || canonicalModel.includes(c));
      });
      if (similar.length > 0) {
        const names = similar.slice(0, 3).join('、');
        return `模型名 "${modelName}" 不存在，但有相似模型：${names}。请确认模型名是否正确。`;
      }
      return `模型 "${modelName}" 未在任何站点的模型列表中，请先同步站点模型。`;
    }

    // Model exists globally but not in the specified scope
    if (siteId) {
      return `模型 "${modelName}" 在其他站点有 ${globalCount} 条记录，但当前站点无记录。请先同步该站点的模型列表。`;
    }
    if (accountId) {
      return `模型 "${modelName}" 在其他账户有 ${globalCount} 条记录，但指定账户无记录。`;
    }
    return `模型 "${modelName}" 有 ${globalCount} 条记录，但均不在当前作用域内。`;
  }

  // 2. Rows exist in scope — determine why they were filtered out.
  const disabledModelsIndex = await loadSiteDisabledModelsIndex();
  const activeRows = matchingRows.filter((r: any) => r.siteStatus === 'active' && r.accountStatus === 'active');
  const disabledBySiteModel = activeRows.filter((r: any) =>
    isModelDisabledForSite(disabledModelsIndex, r.siteId, r.modelName, r.accountId)
    || isModelDisabledForSite(disabledModelsIndex, r.siteId, canonicalModel, r.accountId),
  );

  if (activeRows.length > 0 && disabledBySiteModel.length === activeRows.length) {
    const siteName = activeRows[0]!.siteName || `站点 ${activeRows[0]!.siteId}`;
    return `模型 "${modelName}" 在 ${siteName} 被「站点禁用模型」屏蔽，请先在站点设置中移除该模型的禁用。`;
  }

  const inactiveAccounts = matchingRows.filter((r: any) => r.accountStatus !== 'active');
  const inactiveSites = matchingRows.filter((r: any) => r.siteStatus !== 'active');

  // 2d. Check token-level
  let tokenDiag = '';
  const allTokenRows = await db.select({
    modelName: schema.tokenModelAvailability.modelName,
    tokenEnabled: schema.accountTokens.enabled,
    tokenValueStatus: schema.accountTokens.valueStatus,
  })
    .from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      ...(accountId ? [eq(schema.accounts.id, accountId)] : []),
      ...(siteId ? [eq(schema.sites.id, siteId)] : []),
    ))
    .all();
  const matchingTokenRows = allTokenRows.filter((row: any) => {
    const dbCanonical = canonicalizeModelName(row.modelName) || row.modelName.toLowerCase();
    return dbCanonical === canonicalModel;
  });
  if (matchingTokenRows.length > 0) {
    const notReady = matchingTokenRows.filter((r: any) =>
      !r.tokenEnabled || r.tokenValueStatus !== ACCOUNT_TOKEN_VALUE_STATUS_READY,
    ).length;
    if (notReady > 0) {
      tokenDiag = `${notReady} 个令牌未就绪`;
    }
  }

  // Build final message
  const parts: string[] = [];
  if (disabledBySiteModel.length > 0) {
    parts.push(`${disabledBySiteModel.length} 个被站点禁用模型屏蔽`);
  }
  if (inactiveAccounts.length > 0) {
    parts.push(`${inactiveAccounts.length} 个账户已禁用`);
  }
  if (inactiveSites.length > 0) {
    parts.push(`${inactiveSites.length} 个站点已禁用`);
  }
  if (tokenDiag) {
    parts.push(tokenDiag);
  }

  if (parts.length === 0) {
    return `模型 "${modelName}" 有 ${scopedTotal} 条记录，但所有可测活目标均被过滤。`;
  }
  return `模型 "${modelName}" 有 ${scopedTotal} 条记录，但无法测活：${parts.join('；')}。`;
}
function summarizeMarketplaceProbeResults(
  modelName: string,
  results: SingleModelProbeResult[],
  reasonOverride?: string,
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
      reason: reasonOverride || 'no active account/token currently lists this model',
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

  const targets = await collectMarketplaceProbeTargets(normalized, options);
  if (targets.length === 0) {
    const reason = await diagnoseNoProbeTargets(normalized, options);
    return summarizeMarketplaceProbeResults(normalized, [], reason);
  }

  const results = await mapWithConcurrency(targets, 2, async (target) => {
    return await probeMarketplaceTarget(target, normalized);
  });

  return summarizeMarketplaceProbeResults(normalized, results);
}

/**
 * Streaming variant: probes each target and invokes onResult as soon as each
 * account finishes. Returns the same aggregate as probeSingleModelAvailability.
 */
export async function probeSingleModelAvailabilityStream(
  modelName: string,
  options: MarketplaceModelProbeOptions,
  onResult: (result: SingleModelProbeResult) => void | Promise<void>,
): Promise<MarketplaceModelProbeResponse> {
  const normalized = String(modelName || '').trim();
  if (!normalized) {
    return summarizeMarketplaceProbeResults('', []);
  }

  const targets = await collectMarketplaceProbeTargets(normalized, options);
  if (targets.length === 0) {
    const reason = await diagnoseNoProbeTargets(normalized, options);
    return summarizeMarketplaceProbeResults(normalized, [], reason);
  }

  const results: SingleModelProbeResult[] = [];
  await mapWithConcurrency(targets, 2, async (target) => {
    const result = await probeMarketplaceTarget(target, normalized);
    results.push(result);
    await onResult(result);
  });

  return summarizeMarketplaceProbeResults(normalized, results);
}

async function collectMarketplaceProbeTargets(
  normalized: string,
  options: MarketplaceModelProbeOptions,
): Promise<MarketplaceProbeTarget[]> {
  const disabledModelsIndex = await loadSiteDisabledModelsIndex();
  const canonicalModel = canonicalizeModelName(normalized) || normalized.toLowerCase();

  const siteId = Number.isFinite(options.siteId as number) && Number(options.siteId) > 0
    ? Math.trunc(Number(options.siteId))
    : null;
  const accountId = Number.isFinite(options.accountId as number) && Number(options.accountId) > 0
    ? Math.trunc(Number(options.accountId))
    : null;

  // Fetch all active rows with site/account filters, then match by canonical model name in JS
  // to handle provider-prefix, case, and free-suffix variants.
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
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
      ...(accountId ? [eq(schema.accounts.id, accountId)] : []),
      ...(siteId ? [eq(schema.sites.id, siteId)] : []),
    ))
    .orderBy(asc(schema.sites.id), asc(schema.accounts.id))
    .all()
    .then((rows: any) => rows.filter((row: any) => {
      const dbCanonical = canonicalizeModelName(row.modelName) || row.modelName.toLowerCase();
      return dbCanonical === canonicalModel;
    }));

  const targetsByAccount = new Map<number, MarketplaceProbeTarget>();
  for (const hit of accountHits) {
    if (targetsByAccount.has(hit.account.id)) continue;
    if (isModelDisabledForSite(disabledModelsIndex, hit.site.id, hit.modelName, hit.account.id)
      || isModelDisabledForSite(disabledModelsIndex, hit.site.id, canonicalModel, hit.account.id)) {
      continue;
    }
    targetsByAccount.set(hit.account.id, {
      accountRowId: hit.rowId,
      tokenRowId: null,
      upstreamModelName: String(hit.modelName || normalized),
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
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      ...(accountId ? [eq(schema.accounts.id, accountId)] : []),
      ...(siteId ? [eq(schema.sites.id, siteId)] : []),
    ))
    .orderBy(asc(schema.sites.id), asc(schema.accounts.id))
    .all()
    .then((rows: any) => rows.filter((row: any) => {
      const dbCanonical = canonicalizeModelName(row.modelName) || row.modelName.toLowerCase();
      return dbCanonical === canonicalModel;
    }));

  for (const hit of tokenHits) {
    if (!isUsableAccountToken(hit.token)) continue;
    if (isModelDisabledForSite(disabledModelsIndex, hit.site.id, hit.modelName, hit.account.id)
      || isModelDisabledForSite(disabledModelsIndex, hit.site.id, canonicalModel, hit.account.id)) {
      continue;
    }
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
      upstreamModelName: String(hit.modelName || normalized),
      account: hit.account,
      site: hit.site,
      tokenValue: String(hit.token.token || '').trim() || undefined,
    });
  }

  return [...targetsByAccount.values()];
}

async function probeMarketplaceTarget(
  target: MarketplaceProbeTarget,
  normalized: string,
): Promise<SingleModelProbeResult> {
  const tokenValue = target.tokenValue || await resolvePreferredTokenValue(target.account.id);
  const probe = await probeRuntimeModel({
    site: target.site,
    account: target.account,
    // Canonical matching decides that aliases are equivalent, but the
    // upstream may only accept the spelling it advertised (e.g.
    // deepseek-v4-flash-free). Probe with that concrete spelling instead of
    // sending the canonical marketplace name and losing the alias.
    modelName: target.upstreamModelName || normalized,
    timeoutMs: resolveModelAvailabilityProbeTimeoutMs(),
    tokenValue,
  });

  if (probe.status === 'supported' || probe.status === 'unsupported') {
    const checkedAt = new Date().toISOString();
    if (target.accountRowId != null) {
      await db.update(schema.modelAvailability)
        .set({
          connectivity: probe.status === 'supported',
          latencyMs: probe.latencyMs,
          checkedAt,
        })
        .where(eq(schema.modelAvailability.id, target.accountRowId))
        .run();
    }
    if (target.tokenRowId != null) {
      await db.update(schema.tokenModelAvailability)
        .set({
          connectivity: probe.status === 'supported',
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
}
