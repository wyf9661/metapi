import { and, eq, inArray, sql } from 'drizzle-orm';
import { minimatch } from 'minimatch';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY, type DownstreamRoutingPolicy } from './downstreamPolicyTypes.js';

export type DownstreamApiKeyRow = typeof schema.downstreamApiKeys.$inferSelect;

export type DownstreamApiKeyPolicyView = {
  id: number;
  name: string;
  key: string;
  keyMasked: string;
  description: string | null;
  groupName: string | null;
  tags: string[];
  enabled: boolean;
  expiresAt: string | null;
  maxCost: number | null;
  usedCost: number;
  maxRequests: number | null;
  usedRequests: number;
  supportedModels: string[];
  allowedRouteIds: number[];
  siteWeightMultipliers: Record<number, number>;
  lastUsedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DownstreamTokenAuthSuccess = {
  ok: true;
  source: 'managed' | 'global';
  token: string;
  key: DownstreamApiKeyPolicyView | null;
  policy: DownstreamRoutingPolicy;
};

export type DownstreamTokenAuthFailure = {
  ok: false;
  statusCode: number;
  error: string;
  reason: 'missing' | 'invalid' | 'disabled' | 'expired' | 'over_cost' | 'over_requests';
};

export type DownstreamTokenAuthResult = DownstreamTokenAuthSuccess | DownstreamTokenAuthFailure;

function isRegexModelPattern(pattern: string): boolean {
  return pattern.trim().toLowerCase().startsWith('re:');
}

function parseRegexModelPattern(pattern: string): RegExp | null {
  if (!isRegexModelPattern(pattern)) return null;
  const body = pattern.trim().slice(3).trim();
  if (!body) return null;
  try {
    return new RegExp(body);
  } catch {
    return null;
  }
}

function normalizeToken(raw: string): string {
  return (raw || '').trim();
}

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function getExposedRouteName(route: { modelPattern: string; displayName: string | null }): string {
  return (route.displayName || '').trim() || route.modelPattern.trim();
}

function normalizePositiveNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function normalizePositiveIntegerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const normalized = Math.trunc(n);
  if (normalized < 0) return null;
  return normalized;
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function normalizeGroupNameInput(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value) return null;
  return value.slice(0, 64);
}

export function normalizeTagsInput(input: unknown): string[] {
  const rawValues = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(/[\r\n,，]+/g) : []);

  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawValues) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const normalized = value.slice(0, 32);
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    tags.push(normalized);
    if (tags.length >= 20) break;
  }

  return tags;
}

export function normalizeSupportedModelsInput(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item, index, arr) => item.length > 0 && arr.indexOf(item) === index)
      .slice(0, 200);
  }

  if (typeof input === 'string') {
    return input
      .split(/\r?\n|,/g)
      .map((item) => item.trim())
      .filter((item, index, arr) => item.length > 0 && arr.indexOf(item) === index)
      .slice(0, 200);
  }

  return [];
}

export function normalizeAllowedRouteIdsInput(input: unknown): number[] {
  const rawValues = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(/\r?\n|,/g) : []);

  const routeIds: number[] = [];
  for (const item of rawValues) {
    const n = Number(item);
    if (!Number.isFinite(n)) continue;
    const normalized = Math.trunc(n);
    if (normalized <= 0 || routeIds.includes(normalized)) continue;
    routeIds.push(normalized);
    if (routeIds.length >= 500) break;
  }

  return routeIds;
}

export function normalizeSiteWeightMultipliersInput(input: unknown): Record<number, number> {
  const raw = (typeof input === 'string')
    ? parseJson(input)
    : input;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const result: Record<number, number> = {};
  for (const [rawSiteId, rawMultiplier] of Object.entries(raw as Record<string, unknown>)) {
    const siteId = Number(rawSiteId);
    const multiplier = Number(rawMultiplier);
    if (!Number.isFinite(siteId) || !Number.isFinite(multiplier)) continue;
    const normalizedSiteId = Math.trunc(siteId);
    if (normalizedSiteId <= 0 || multiplier <= 0) continue;
    result[normalizedSiteId] = multiplier;
  }

  return result;
}

export function matchesDownstreamModelPattern(model: string, pattern: string): boolean {
  const normalizedPattern = (pattern || '').trim();
  if (!normalizedPattern) return false;

  if (normalizedPattern === model) return true;

  if (isRegexModelPattern(normalizedPattern)) {
    const re = parseRegexModelPattern(normalizedPattern);
    return !!re && re.test(model);
  }

  return minimatch(model, normalizedPattern);
}

export function isModelAllowedByPolicy(model: string, policy: DownstreamRoutingPolicy): boolean {
  const patterns = Array.isArray(policy.supportedModels)
    ? policy.supportedModels
    : [];

  if (patterns.length === 0) return true;

  return patterns.some((pattern) => matchesDownstreamModelPattern(model, pattern));
}

async function isModelMatchedByAllowedRoutes(model: string, allowedRouteIds: number[]): Promise<boolean> {
  if (allowedRouteIds.length === 0) return false;

  const routes = await db.select({
    id: schema.tokenRoutes.id,
    modelPattern: schema.tokenRoutes.modelPattern,
    displayName: schema.tokenRoutes.displayName,
  })
    .from(schema.tokenRoutes)
    .where(and(
      inArray(schema.tokenRoutes.id, allowedRouteIds),
      eq(schema.tokenRoutes.enabled, true),
    ))
    .all();

  return routes.some((route) => getExposedRouteName(route) === model);
}

export async function isModelAllowedByPolicyOrAllowedRoutes(model: string, policy: DownstreamRoutingPolicy): Promise<boolean> {
  const patterns = normalizeSupportedModelsInput(policy.supportedModels);
  const allowedRouteIds = normalizeAllowedRouteIdsInput(policy.allowedRouteIds);
  const hasPatternRules = patterns.length > 0;
  const hasRouteRules = allowedRouteIds.length > 0;

  if (!hasPatternRules && !hasRouteRules) return false;

  if (hasPatternRules && patterns.some((pattern) => matchesDownstreamModelPattern(model, pattern))) {
    return true;
  }

  if (!hasRouteRules) return false;

  return await isModelMatchedByAllowedRoutes(model, allowedRouteIds);
}

export function toDownstreamApiKeyPolicyView(row: DownstreamApiKeyRow): DownstreamApiKeyPolicyView {
  const supportedModels = normalizeSupportedModelsInput(parseJson(row.supportedModels));
  const allowedRouteIds = normalizeAllowedRouteIdsInput(parseJson(row.allowedRouteIds));
  const siteWeightMultipliers = normalizeSiteWeightMultipliersInput(parseJson(row.siteWeightMultipliers));

  return {
    id: row.id,
    name: row.name,
    key: row.key,
    keyMasked: maskSecret(row.key),
    description: row.description || null,
    groupName: normalizeGroupNameInput(row.groupName),
    tags: normalizeTagsInput(parseJson(row.tags)),
    enabled: !!row.enabled,
    expiresAt: row.expiresAt || null,
    maxCost: row.maxCost ?? null,
    usedCost: Number(row.usedCost || 0),
    maxRequests: row.maxRequests ?? null,
    usedRequests: Number(row.usedRequests || 0),
    supportedModels,
    allowedRouteIds,
    siteWeightMultipliers,
    lastUsedAt: row.lastUsedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

export function toPolicyFromView(view: Pick<DownstreamApiKeyPolicyView, 'supportedModels' | 'allowedRouteIds' | 'siteWeightMultipliers'>): DownstreamRoutingPolicy {
  return {
    supportedModels: normalizeSupportedModelsInput(view.supportedModels),
    allowedRouteIds: normalizeAllowedRouteIdsInput(view.allowedRouteIds),
    siteWeightMultipliers: normalizeSiteWeightMultipliersInput(view.siteWeightMultipliers),
  };
}

export async function listDownstreamApiKeys(): Promise<DownstreamApiKeyPolicyView[]> {
  return (await db.select().from(schema.downstreamApiKeys)
    .all())
    .map((row) => toDownstreamApiKeyPolicyView(row))
    .sort((a, b) => b.id - a.id);
}

export async function getDownstreamApiKeyById(id: number): Promise<DownstreamApiKeyPolicyView | null> {
  const row = await db.select().from(schema.downstreamApiKeys)
    .where(eq(schema.downstreamApiKeys.id, id))
    .get();
  if (!row) return null;
  return toDownstreamApiKeyPolicyView(row);
}

export async function getManagedDownstreamApiKeyByToken(token: string): Promise<DownstreamApiKeyPolicyView | null> {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) return null;

  const row = await db.select().from(schema.downstreamApiKeys)
    .where(eq(schema.downstreamApiKeys.key, normalizedToken))
    .get();

  if (!row) return null;
  return toDownstreamApiKeyPolicyView(row);
}

export function getDefaultGlobalPolicy(): DownstreamRoutingPolicy {
  return EMPTY_DOWNSTREAM_ROUTING_POLICY;
}

export async function authorizeDownstreamToken(token: string): Promise<DownstreamTokenAuthResult> {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) {
    return {
      ok: false,
      statusCode: 401,
      error: 'Missing Authorization or x-api-key header',
      reason: 'missing',
    };
  }

  const managed = await getManagedDownstreamApiKeyByToken(normalizedToken);
  if (managed) {
    if (!managed.enabled) {
      return {
        ok: false,
        statusCode: 403,
        error: 'API key is disabled',
        reason: 'disabled',
      };
    }

    if (managed.expiresAt) {
      const expiresAtTs = Date.parse(managed.expiresAt);
      if (Number.isFinite(expiresAtTs) && expiresAtTs <= Date.now()) {
        return {
          ok: false,
          statusCode: 403,
          error: 'API key is expired',
          reason: 'expired',
        };
      }
    }

    if (managed.maxCost !== null && managed.usedCost >= managed.maxCost) {
      return {
        ok: false,
        statusCode: 403,
        error: 'API key has exceeded max cost',
        reason: 'over_cost',
      };
    }

    if (managed.maxRequests !== null && managed.usedRequests >= managed.maxRequests) {
      return {
        ok: false,
        statusCode: 403,
        error: 'API key has exceeded max requests',
        reason: 'over_requests',
      };
    }

    return {
      ok: true,
      source: 'managed',
      token: normalizedToken,
      key: managed,
      policy: toPolicyFromView(managed),
    };
  }

  if (normalizedToken === config.proxyToken) {
    return {
      ok: true,
      source: 'global',
      token: normalizedToken,
      key: null,
      policy: getDefaultGlobalPolicy(),
    };
  }

  return {
    ok: false,
    statusCode: 403,
    error: 'Invalid API key',
    reason: 'invalid',
  };
}

export async function consumeManagedKeyRequest(keyId: number): Promise<void> {
  const nowIso = new Date().toISOString();
  await db.update(schema.downstreamApiKeys).set({
    // Atomic increment to avoid lost updates under multi-process concurrency.
    usedRequests: sql`coalesce(${schema.downstreamApiKeys.usedRequests}, 0) + 1`,
    lastUsedAt: nowIso,
    updatedAt: nowIso,
  }).where(eq(schema.downstreamApiKeys.id, keyId)).run();
}

export async function recordManagedKeyCostUsage(keyId: number, estimatedCost: number): Promise<void> {
  const cost = Number(estimatedCost);
  if (!Number.isFinite(cost) || cost <= 0) return;
  const nowIso = new Date().toISOString();
  await db.update(schema.downstreamApiKeys).set({
    // Atomic increment to avoid lost updates under multi-process concurrency.
    usedCost: sql`coalesce(${schema.downstreamApiKeys.usedCost}, 0) + ${cost}`,
    lastUsedAt: nowIso,
    updatedAt: nowIso,
  }).where(eq(schema.downstreamApiKeys.id, keyId)).run();
}

export function normalizeDownstreamApiKeyPayload(input: {
  name?: unknown;
  key?: unknown;
  description?: unknown;
  groupName?: unknown;
  tags?: unknown;
  enabled?: unknown;
  expiresAt?: unknown;
  maxCost?: unknown;
  maxRequests?: unknown;
  supportedModels?: unknown;
  allowedRouteIds?: unknown;
  siteWeightMultipliers?: unknown;
}) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  const description = typeof input.description === 'string'
    ? input.description.trim()
    : '';
  const groupName = normalizeGroupNameInput(input.groupName);
  const tags = normalizeTagsInput(input.tags);
  const enabled = input.enabled === undefined ? true : !!input.enabled;

  const expiresAtRaw = typeof input.expiresAt === 'string'
    ? input.expiresAt.trim()
    : (input.expiresAt === null ? '' : '');
  let expiresAt: string | null = null;
  if (expiresAtRaw) {
    const ts = Date.parse(expiresAtRaw);
    if (!Number.isFinite(ts)) {
      throw new Error('expiresAt 必须是有效时间');
    }
    expiresAt = new Date(ts).toISOString();
  }

  const maxCost = normalizePositiveNumberOrNull(input.maxCost);
  const maxRequests = normalizePositiveIntegerOrNull(input.maxRequests);
  const supportedModels = normalizeSupportedModelsInput(input.supportedModels);
  const allowedRouteIds = normalizeAllowedRouteIdsInput(input.allowedRouteIds);
  const siteWeightMultipliers = normalizeSiteWeightMultipliersInput(input.siteWeightMultipliers);

  return {
    name,
    key,
    description: description || null,
    groupName,
    tags,
    enabled,
    expiresAt,
    maxCost,
    maxRequests,
    supportedModels,
    allowedRouteIds,
    siteWeightMultipliers,
  };
}

export function toPersistenceJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) {
    return null;
  }
  return JSON.stringify(value);
}
