import type { RequestInit as UndiciRequestInit } from 'undici';
import { withSiteProxyRequestInit } from './siteProxy.js';
import {
  buildNewApiCookieCandidates,
  fetchJsonWithShieldCookieRetry,
} from './platforms/newApiShield.js';

const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;
const PRICE_CACHE_FAILURE_TTL_MS = 60 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_GROUP = 'default';
const ONE_HUB_PER_CALL_RATIO = 0.002;
const MIN_ROUTING_REFERENCE_COST = 1e-6;
const ROUTING_REFERENCE_USAGE = {
  promptTokens: 500_000,
  completionTokens: 500_000,
  totalTokens: 1_000_000,
};

export interface PricingModel {
  modelName: string;
  quotaType: number;
  modelRatio: number;
  completionRatio: number;
  cacheRatio?: number;
  cacheCreationRatio?: number;
  modelPrice: number | { input: number; output: number } | null;
  enableGroups: string[];
  modelDescription?: string | null;
  tags?: string[];
  supportedEndpointTypes?: string[];
  ownerBy?: string | null;
}

interface PricingData {
  models: Map<string, PricingModel>;
  groupRatio: Record<string, number>;
}

export interface ProxyBillingPricingOverride {
  modelRatio: number;
  completionRatio: number;
  cacheRatio?: number;
  cacheCreationRatio?: number;
  groupRatio?: number;
}

interface PricingCacheEntry {
  fetchedAt: number;
  ttlMs: number;
  data: PricingData | null;
}

interface RoutingReferenceCostCacheEntry {
  fetchedAt: number;
  ttlMs: number;
  costs: Map<string, number>;
}

export interface EstimateProxyCostInput {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
  modelName: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  promptTokensIncludeCache?: boolean | null;
  billingPricingOverride?: ProxyBillingPricingOverride | null;
}

interface ModelGroupPricing {
  quotaType: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheCreationPerMillion?: number;
  perCallInput?: number;
  perCallOutput?: number;
  perCallTotal?: number;
}

interface ModelPricingCatalogEntry {
  modelName: string;
  quotaType: number;
  modelDescription: string | null;
  tags: string[];
  supportedEndpointTypes: string[];
  ownerBy: string | null;
  enableGroups: string[];
  groupPricing: Record<string, ModelGroupPricing>;
}

interface ModelPricingCatalog {
  models: ModelPricingCatalogEntry[];
  groupRatio: Record<string, number>;
}

export interface ProxyBillingDetails {
  quotaType: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    billablePromptTokens: number;
    promptTokensIncludeCache: boolean | null;
  };
  pricing: {
    modelRatio: number;
    completionRatio: number;
    cacheRatio: number;
    cacheCreationRatio: number;
    groupRatio: number;
  };
  breakdown: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheCreationPerMillion: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheCreationCost: number;
    totalCost: number;
  };
}

const pricingCache = new Map<string, PricingCacheEntry>();
const routingReferenceCostCache = new Map<string, RoutingReferenceCostCacheEntry>();

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function toPositiveInt(value: unknown): number {
  return Math.max(0, Math.round(toNumber(value, 0)));
}

function roundCost(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}

function normalizeModelPrice(value: unknown): number | { input: number; output: number } | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return null;

  const input = toNumber((value as any).input, Number.NaN);
  const output = toNumber((value as any).output, Number.NaN);
  if (Number.isNaN(input) && Number.isNaN(output)) return null;

  return {
    input: Number.isNaN(input) ? 0 : input,
    output: Number.isNaN(output) ? 0 : output,
  };
}

function normalizeGroupRatio(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const ratio = toNumber(value, 1);
      if (ratio > 0) result[key] = ratio;
    }
  }

  if (Object.keys(result).length === 0) {
    result[DEFAULT_GROUP] = 1;
  } else if (!(DEFAULT_GROUP in result)) {
    result[DEFAULT_GROUP] = 1;
  }

  return result;
}

function normalizeStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || '').trim()).filter(Boolean);
  }

  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeRatio(value: unknown, fallback: number): number {
  const ratio = toNumber(value, Number.NaN);
  if (Number.isFinite(ratio) && ratio >= 0) return ratio;
  return fallback;
}

function normalizePricingModels(rawModels: unknown[]): Map<string, PricingModel> {
  const models = new Map<string, PricingModel>();

  for (const raw of rawModels) {
    if (!raw || typeof raw !== 'object') continue;

    const modelName = String((raw as any).model_name || '').trim();
    if (!modelName) continue;

    const quotaType = toPositiveInt((raw as any).quota_type);
    const modelRatio = toNumber((raw as any).model_ratio, 1);
    const completionRatio = toNumber((raw as any).completion_ratio, 1);
    const cacheRatio = normalizeRatio(
      (raw as any).cache_ratio ?? (raw as any).cacheRatio,
      1,
    );
    const cacheCreationRatio = normalizeRatio(
      (raw as any).cache_creation_ratio
        ?? (raw as any).cacheCreationRatio
        ?? (raw as any).create_cache_ratio
        ?? (raw as any).createCacheRatio,
      1,
    );
    const enableGroupsRaw = (raw as any).enable_groups;
    const enableGroups = Array.isArray(enableGroupsRaw)
      ? enableGroupsRaw.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [DEFAULT_GROUP];
    const modelDescriptionRaw = (raw as any).model_description;
    const modelDescription = typeof modelDescriptionRaw === 'string'
      ? (modelDescriptionRaw.trim() || null)
      : null;
    const tags = normalizeStringArray((raw as any).tags);
    const supportedEndpointTypes = normalizeStringArray((raw as any).supported_endpoint_types);
    const ownerByRaw = (raw as any).owner_by;
    const ownerBy = typeof ownerByRaw === 'string' ? (ownerByRaw.trim() || null) : null;

    models.set(modelName, {
      modelName,
      quotaType,
      modelRatio: modelRatio > 0 ? modelRatio : 1,
      completionRatio: completionRatio > 0 ? completionRatio : 1,
      cacheRatio,
      cacheCreationRatio,
      modelPrice: normalizeModelPrice((raw as any).model_price),
      enableGroups: enableGroups.length > 0 ? enableGroups : [DEFAULT_GROUP],
      modelDescription,
      tags,
      supportedEndpointTypes,
      ownerBy,
    });
  }

  return models;
}

function unwrapPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  if ('data' in (payload as any)) return (payload as any).data;
  return payload;
}

function normalizeCommonPricingPayload(payload: unknown): PricingData | null {
  const maybeData = unwrapPayload(payload);
  if (!Array.isArray(maybeData)) return null;

  const models = normalizePricingModels(maybeData);
  if (models.size === 0) return null;

  const groupRatio = normalizeGroupRatio((payload as any)?.group_ratio);
  return { models, groupRatio };
}

async function fetchJson(url: string, options?: UndiciRequestInit): Promise<unknown> {
  const { fetch } = await import('undici');
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, PRICING_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...(await withSiteProxyRequestInit(url, {
        ...options,
        signal: controller.signal,
        body: options?.body ?? undefined,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      })),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`pricing fetch timeout (${Math.round(PRICING_FETCH_TIMEOUT_MS / 1000)}s)`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
}

function normalizeUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function buildTokenCandidates(input: EstimateProxyCostInput): string[] {
  const candidates = [
    input.account.accessToken,
    input.account.apiToken,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return Array.from(new Set(candidates));
}

async function fetchCommonPricing(baseUrl: string, token?: string, sitePlatform?: string): Promise<PricingData | null> {
  const shouldTryShieldCookie = !!token && token.includes('=');
  if (shouldTryShieldCookie) {
    const payload = await fetchJsonViaNewApiShield(`${baseUrl}/api/pricing`, token!);
    const data = normalizeCommonPricingPayload(payload);
    if (data) return data;
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = await fetchJson(`${baseUrl}/api/pricing`, { headers });
  return normalizeCommonPricingPayload(payload);
}

function getCacheKey(input: EstimateProxyCostInput): string {
  return `${input.site.id}:${input.account.id}`;
}

function normalizeModelKey(modelName: string): string {
  return modelName.trim().toLowerCase();
}

function buildRoutingReferenceCostMap(data: PricingData): Map<string, number> {
  const costs = new Map<string, number>();
  for (const model of data.models.values()) {
    const cost = calculateModelUsageCost(model, ROUTING_REFERENCE_USAGE, data.groupRatio);
    if (!Number.isFinite(cost)) continue;
    costs.set(normalizeModelKey(model.modelName), Math.max(cost, MIN_ROUTING_REFERENCE_COST));
  }
  return costs;
}

function syncRoutingReferenceCostCache(
  key: string,
  fetchedAt: number,
  ttlMs: number,
  data: PricingData | null,
): void {
  if (!data) {
    routingReferenceCostCache.delete(key);
    return;
  }

  routingReferenceCostCache.set(key, {
    fetchedAt,
    ttlMs,
    costs: buildRoutingReferenceCostMap(data),
  });
}

async function fetchPricingData(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const baseUrl = normalizeUrl(input.site.url);
  const tokenCandidates = buildTokenCandidates(input);

  const fetcher = (baseUrl: string, token?: string) => fetchCommonPricing(baseUrl, token, input.site.platform);

  for (const token of tokenCandidates) {
    try {
      const data = await fetcher(baseUrl, token);
      if (data && data.models.size > 0) return data;
    } catch {}
  }

  // Some sites expose pricing publicly.
  try {
    const data = await fetcher(baseUrl, undefined);
    if (data && data.models.size > 0) return data;
  } catch {}

  return null;
}

async function getPricingDataCached(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const key = getCacheKey(input);
  const now = Date.now();
  const cached = pricingCache.get(key);
  if (cached && now - cached.fetchedAt < cached.ttlMs) {
    if (cached.data && !routingReferenceCostCache.has(key)) {
      syncRoutingReferenceCostCache(key, cached.fetchedAt, cached.ttlMs, cached.data);
    }
    return cached.data;
  }

  const data = await fetchPricingData(input);
  const ttlMs = data ? PRICE_CACHE_TTL_MS : PRICE_CACHE_FAILURE_TTL_MS;
  pricingCache.set(key, {
    fetchedAt: now,
    ttlMs,
    data,
  });
  syncRoutingReferenceCostCache(key, now, ttlMs, data);
  return data;
}

async function refreshPricingDataCache(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const key = getCacheKey(input);
  const now = Date.now();
  const data = await fetchPricingData(input);
  const ttlMs = data ? PRICE_CACHE_TTL_MS : PRICE_CACHE_FAILURE_TTL_MS;
  pricingCache.set(key, {
    fetchedAt: now,
    ttlMs,
    data,
  });
  syncRoutingReferenceCostCache(key, now, ttlMs, data);
  return data;
}

export function getCachedModelRoutingReferenceCost(input: {
  siteId: number;
  accountId: number;
  modelName: string;
}): number | null {
  const key = `${input.siteId}:${input.accountId}`;
  const cached = routingReferenceCostCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.fetchedAt >= cached.ttlMs) {
    return null;
  }

  const cost = cached.costs.get(normalizeModelKey(input.modelName));
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) {
    return null;
  }

  return cost;
}

function resolveModel(modelName: string, data: PricingData): PricingModel | null {
  const exact = data.models.get(modelName);
  if (exact) return exact;

  const lower = modelName.toLowerCase();
  for (const [name, model] of data.models.entries()) {
    if (name.toLowerCase() === lower) return model;
  }

  return null;
}

function resolveGroupMultiplier(model: PricingModel, groupRatio: Record<string, number>): number {
  if (model.enableGroups.includes(DEFAULT_GROUP) && groupRatio[DEFAULT_GROUP]) {
    return groupRatio[DEFAULT_GROUP];
  }

  for (const group of model.enableGroups) {
    if (groupRatio[group]) return groupRatio[group];
  }

  const first = Object.values(groupRatio).find((ratio) => ratio > 0);
  return first || 1;
}

function calculatePerCallCost(
  modelPrice: number | { input: number; output: number } | null,
  multiplier: number,
): number {
  if (typeof modelPrice === 'number') {
    return modelPrice * multiplier;
  }

  if (modelPrice && typeof modelPrice === 'object') {
    // Object pricing follows the input ratio.
    return toNumber(modelPrice.input, 0) * multiplier * ONE_HUB_PER_CALL_RATIO;
  }

  return 0;
}

function calculatePerCallPricing(
  modelPrice: number | { input: number; output: number } | null,
  multiplier: number,
): { input?: number; output?: number; total: number } {
  if (typeof modelPrice === 'number') {
    const total = roundCost(modelPrice * multiplier);
    return { total };
  }

  if (modelPrice && typeof modelPrice === 'object') {
    const input = roundCost(toNumber(modelPrice.input, 0) * multiplier * ONE_HUB_PER_CALL_RATIO);
    const output = roundCost(toNumber(modelPrice.output, 0) * multiplier * ONE_HUB_PER_CALL_RATIO);
    return {
      input,
      output,
      total: input,
    };
  }

  return { total: 0 };
}

function buildPricingOverrideModel(
  modelName: string,
  pricingOverride: ProxyBillingPricingOverride,
): { model: PricingModel; groupRatio: Record<string, number> } {
  const groupRatio = normalizeRatio(pricingOverride.groupRatio, 1);
  return {
    model: {
      modelName,
      quotaType: 0,
      modelRatio: normalizeRatio(pricingOverride.modelRatio, 1),
      completionRatio: normalizeRatio(pricingOverride.completionRatio, 1),
      cacheRatio: normalizeRatio(pricingOverride.cacheRatio, 1),
      cacheCreationRatio: normalizeRatio(pricingOverride.cacheCreationRatio, 1),
      modelPrice: null,
      enableGroups: [DEFAULT_GROUP],
    },
    groupRatio: { [DEFAULT_GROUP]: groupRatio },
  };
}

function normalizeUsageBreakdownInput(usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  promptTokensIncludeCache?: boolean | null;
}) {
  const promptTokens = toPositiveInt(usage.promptTokens);
  const completionTokens = toPositiveInt(usage.completionTokens);
  const totalTokensRaw = toPositiveInt(usage.totalTokens);
  const totalTokens = Math.max(totalTokensRaw, promptTokens + completionTokens);
  const cacheReadTokens = toPositiveInt(usage.cacheReadTokens);
  const cacheCreationTokens = toPositiveInt(usage.cacheCreationTokens);
  const promptTokensIncludeCache = usage.promptTokensIncludeCache ?? null;
  const hasSplit = promptTokens > 0 || completionTokens > 0;
  const effectivePromptTokens = hasSplit ? promptTokens : totalTokens;
  const billablePromptTokens = promptTokensIncludeCache === false
    ? effectivePromptTokens
    : Math.max(0, effectivePromptTokens - cacheReadTokens - cacheCreationTokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    billablePromptTokens,
    promptTokensIncludeCache,
  };
}

export function calculateModelUsageBreakdown(
  model: PricingModel,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    promptTokensIncludeCache?: boolean | null;
  },
  groupRatio: Record<string, number>,
): ProxyBillingDetails | null {
  if (model.quotaType === 1) {
    return null;
  }

  const multiplier = resolveGroupMultiplier(model, groupRatio);
  const normalizedUsage = normalizeUsageBreakdownInput(usage);
  const cacheRatio = model.cacheRatio ?? 1;
  const cacheCreationRatio = model.cacheCreationRatio ?? 1;
  const inputPerMillion = roundCost(model.modelRatio * 2 * multiplier);
  const outputPerMillion = roundCost(model.modelRatio * model.completionRatio * 2 * multiplier);
  const cacheReadPerMillion = roundCost(model.modelRatio * cacheRatio * 2 * multiplier);
  const cacheCreationPerMillion = roundCost(model.modelRatio * cacheCreationRatio * 2 * multiplier);
  const inputCost = roundCost((normalizedUsage.billablePromptTokens / 1_000_000) * inputPerMillion);
  const outputCost = roundCost((normalizedUsage.completionTokens / 1_000_000) * outputPerMillion);
  const cacheReadCost = roundCost((normalizedUsage.cacheReadTokens / 1_000_000) * cacheReadPerMillion);
  const cacheCreationCost = roundCost((normalizedUsage.cacheCreationTokens / 1_000_000) * cacheCreationPerMillion);
  const totalCost = roundCost(inputCost + outputCost + cacheReadCost + cacheCreationCost);

  return {
    quotaType: model.quotaType,
    usage: normalizedUsage,
    pricing: {
      modelRatio: model.modelRatio,
      completionRatio: model.completionRatio,
      cacheRatio,
      cacheCreationRatio,
      groupRatio: multiplier,
    },
    breakdown: {
      inputPerMillion,
      outputPerMillion,
      cacheReadPerMillion,
      cacheCreationPerMillion,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheCreationCost,
      totalCost,
    },
  };
}

export function calculateModelUsageCost(
  model: PricingModel,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    promptTokensIncludeCache?: boolean | null;
  },
  groupRatio: Record<string, number>,
): number {
  const multiplier = resolveGroupMultiplier(model, groupRatio);

  if (model.quotaType === 1) {
    return roundCost(calculatePerCallCost(model.modelPrice, multiplier));
  }

  return calculateModelUsageBreakdown(model, usage, groupRatio)?.breakdown.totalCost ?? 0;
}

function buildModelPricingCatalogFromData(pricingData: PricingData): ModelPricingCatalog {
  const groups = Array.from(new Set([DEFAULT_GROUP, ...Object.keys(pricingData.groupRatio)]));
  const defaultMultiplier = pricingData.groupRatio[DEFAULT_GROUP] || 1;

  const models: ModelPricingCatalogEntry[] = Array.from(pricingData.models.values())
    .map((model) => {
      const allowedGroups = Array.from(new Set([...(model.enableGroups || []), DEFAULT_GROUP]));
      const modelGroups = groups.filter((group) => allowedGroups.includes(group));
      const effectiveGroups = modelGroups.length > 0 ? modelGroups : [DEFAULT_GROUP];

      const groupPricing = effectiveGroups.reduce<Record<string, ModelGroupPricing>>((acc, group) => {
        const multiplier = pricingData.groupRatio[group] || defaultMultiplier;
        if (model.quotaType === 1) {
          const perCall = calculatePerCallPricing(model.modelPrice, multiplier);
          acc[group] = {
            quotaType: 1,
            perCallInput: perCall.input,
            perCallOutput: perCall.output,
            perCallTotal: perCall.total,
          };
          return acc;
        }

        acc[group] = {
          quotaType: 0,
          inputPerMillion: roundCost(model.modelRatio * 2 * multiplier),
          outputPerMillion: roundCost(model.modelRatio * model.completionRatio * 2 * multiplier),
          cacheReadPerMillion: roundCost(model.modelRatio * (model.cacheRatio ?? 1) * 2 * multiplier),
          cacheCreationPerMillion: roundCost(model.modelRatio * (model.cacheCreationRatio ?? 1) * 2 * multiplier),
        };
        return acc;
      }, {});

      return {
        modelName: model.modelName,
        quotaType: model.quotaType,
        modelDescription: model.modelDescription || null,
        tags: model.tags || [],
        supportedEndpointTypes: model.supportedEndpointTypes || [],
        ownerBy: model.ownerBy || null,
        enableGroups: model.enableGroups || [DEFAULT_GROUP],
        groupPricing,
      };
    })
    .sort((a, b) => a.modelName.localeCompare(b.modelName));

  return {
    models,
    groupRatio: pricingData.groupRatio,
  };
}

export async function fetchModelPricingCatalog(input: EstimateProxyCostInput): Promise<ModelPricingCatalog | null> {
  const pricingData = await getPricingDataCached(input);
  if (!pricingData) return null;
  return buildModelPricingCatalogFromData(pricingData);
}

export async function refreshModelPricingCatalog(input: EstimateProxyCostInput): Promise<ModelPricingCatalog | null> {
  const pricingData = await refreshPricingDataCache(input);
  if (!pricingData) return null;
  return buildModelPricingCatalogFromData(pricingData);
}

export function fallbackTokenCost(totalTokens: number, platform: string): number {
  return roundCost(toPositiveInt(totalTokens) / 500_000);
}

export async function estimateProxyCost(input: EstimateProxyCostInput): Promise<number> {
  const promptTokens = toPositiveInt(input.promptTokens);
  const completionTokens = toPositiveInt(input.completionTokens);
  const totalTokens = toPositiveInt(input.totalTokens || (promptTokens + completionTokens));
  const usage = {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    promptTokensIncludeCache: input.promptTokensIncludeCache,
  };

  try {
    if (input.billingPricingOverride) {
      const pricingOverride = buildPricingOverrideModel(input.modelName, input.billingPricingOverride);
      return calculateModelUsageCost(pricingOverride.model, usage, pricingOverride.groupRatio);
    }

    const pricingData = await getPricingDataCached(input);
    if (!pricingData) {
      return fallbackTokenCost(totalTokens, input.site.platform);
    }

    const model = resolveModel(input.modelName, pricingData);
    if (!model) {
      return fallbackTokenCost(totalTokens, input.site.platform);
    }

    return calculateModelUsageCost(model, usage, pricingData.groupRatio);
  } catch {
    return fallbackTokenCost(totalTokens, input.site.platform);
  }
}

async function fetchJsonViaNewApiShield(url: string, token: string): Promise<unknown> {
  for (const cookie of buildNewApiCookieCandidates(token)) {
    const result = await fetchJsonWithShieldCookieRetry(url, {
      headers: { Cookie: cookie },
    });
    if (result.data) return result.data;
  }

  return null;
}

export async function buildProxyBillingDetails(input: EstimateProxyCostInput): Promise<ProxyBillingDetails | null> {
  const promptTokens = toPositiveInt(input.promptTokens);
  const completionTokens = toPositiveInt(input.completionTokens);
  const totalTokens = toPositiveInt(input.totalTokens || (promptTokens + completionTokens));
  const usage = {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    promptTokensIncludeCache: input.promptTokensIncludeCache,
  };

  try {
    if (input.billingPricingOverride) {
      const pricingOverride = buildPricingOverrideModel(input.modelName, input.billingPricingOverride);
      return calculateModelUsageBreakdown(pricingOverride.model, usage, pricingOverride.groupRatio);
    }

    const pricingData = await getPricingDataCached(input);
    if (!pricingData) return null;

    const model = resolveModel(input.modelName, pricingData);
    if (!model || model.quotaType === 1) return null;

    return calculateModelUsageBreakdown(model, usage, pricingData.groupRatio);
  } catch {
    return null;
  }
}
