/**
 * models.dev official model-price catalog sync + lookup.
 *
 * Middle tier of the proxy cost-estimation fallback chain (for stations that
 * expose NO `/api/pricing`, e.g. plain "direct key" OpenAI-compatible sites):
 *
 *   upstream /api/pricing  >  models.dev sync prices  >  flat token fallback
 *
 * Data source: https://models.dev/api.json (sst/models.dev, MIT-licensed data),
 * ~5800 models with `cost: { input, output, cache_read?, cache_write? }` in
 * USD per 1M tokens. Synced once at boot (async, non-blocking) then refreshed
 * daily. Sync failures are silent: stale in-memory data stays in place and the
 * existing flat fallback still applies — models.dev is an estimate baseline,
 * never billing truth.
 *
 * All pricing math lives in modelPricingService; this module owns the data
 * table, the fetch/parse lifecycle, and the lookup helper.
 */

import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { fetch } from 'undici';
import type { PricingModel } from './modelPricingService.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const SYNC_TIMEOUT_MS = 30_000;
const SYNC_DAILY_CRON = '0 3 * * *'; // refresh once a day in the quiet window
const MAX_MEMORY_MODELS = 50_000; // hard cap against an unexpectedly huge payload

/**
 * Cost of one model from models.dev, USD per 1M tokens. Only the four fields
 * MetAPI bills on are kept; tiered/audio/reasoning pricing variants are
 * intentionally ignored (base price is the estimate baseline).
 */
export interface ModelsDevCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Official provider names whose prices must win over third-party resellers
 * when the same model id appears under multiple providers in api.json.
 */
const OFFICIAL_PROVIDER_PRIORITY = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'xai',
  'alibaba',
  'zhipuai',
  'minimax',
  'moonshotai',
  'mistralai',
  'meta',
  'cohere',
  'amazon',
  'microsoft',
  'nvidia',
];

let modelsDevPrices = new Map<string, ModelsDevCost>();
let lastSyncAtMs = 0;
let syncTask: ScheduledTask | null = null;

function normalizeModelName(modelName: string): string {
  // Lowercase and strip `:free` / `:reasoning` style variant suffixes.
  return modelName.trim().replace(/[:/].*$/, '').toLowerCase();
}

function stripDateSuffix(modelName: string): string {
  // Vendor date/version suffixes: `gpt-4o-2024-08-06`, `claude-3-7-sonnet-20250219`.
  return modelName
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
}

function toNonNegativeNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseCost(raw: unknown): ModelsDevCost | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const input = toNonNegativeNumber(record.input, Number.NaN);
  const output = toNonNegativeNumber(record.output, Number.NaN);
  // A cost entry without an input or output price is unusable for billing.
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (input === 0 && output === 0) return null;

  const cost: ModelsDevCost = { input, output };
  const cacheRead = toNonNegativeNumber(record.cache_read ?? record.cacheRead, Number.NaN);
  if (Number.isFinite(cacheRead)) cost.cacheRead = cacheRead;
  const cacheWrite = toNonNegativeNumber(record.cache_write ?? record.cacheWrite, Number.NaN);
  if (Number.isFinite(cacheWrite)) cost.cacheWrite = cacheWrite;
  return cost;
}

/**
 * Parse the full models.dev api.json payload into a price map.
 * Official providers are written first and keep their price when a
 * third-party provider lists the same model id (keep-first); third-party-only
 * models still enter the table. Pure function for unit testing.
 */
export function parseModelsDevPrices(jsonText: string): Map<string, ModelsDevCost> | null {
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const providers = payload as Record<string, unknown>;
  const result = new Map<string, ModelsDevCost>();

  const ingestProvider = (providerName: string, value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const models = (value as Record<string, unknown>).models;
    if (!models || typeof models !== 'object') return;
    for (const [modelId, entry] of Object.entries(models as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const cost = parseCost((entry as Record<string, unknown>).cost);
      if (!cost) continue;
      const normalized = normalizeModelName(String(modelId));
      if (!normalized) continue;
      if (!result.has(normalized)) {
        result.set(normalized, cost);
      }
    }
  };

  for (const name of OFFICIAL_PROVIDER_PRIORITY) {
    const value = providers[name];
    if (value) ingestProvider(name, value);
  }
  for (const [name, value] of Object.entries(providers)) {
    if (OFFICIAL_PROVIDER_PRIORITY.includes(name)) continue;
    ingestProvider(name, value);
    if (result.size > MAX_MEMORY_MODELS) break;
  }

  return result;
}

/** Look up a model's official price. Pure function; exact then date-stripped. */
export function lookupModelsDevPrice(modelName: string): ModelsDevCost | null {
  const normalized = normalizeModelName(modelName);
  if (!normalized) return null;

  const exact = modelsDevPrices.get(normalized);
  if (exact) return exact;

  const stripped = stripDateSuffix(normalized);
  if (stripped !== normalized) {
    const fromStripped = modelsDevPrices.get(stripped);
    if (fromStripped) return fromStripped;
  }
  return null;
}

/**
 * Convert a models.dev cost into the PricingModel shape consumed by
 * modelPricingService. Aligns the quota unit so that 1 unit = $1:
 * modelRatio = input/2 makes `inputPerMillion = modelRatio * 2 = input` (USD/M).
 */
export function modelsDevCostToPricingModel(modelName: string, cost: ModelsDevCost): PricingModel {
  const input = cost.input > 0 ? cost.input : 1;
  const output = cost.output > 0 ? cost.output : input;
  return {
    modelName,
    quotaType: 0,
    modelRatio: input / 2,
    completionRatio: output / input,
    cacheRatio: cost.cacheRead != null ? cost.cacheRead / input : 1,
    cacheCreationRatio: cost.cacheWrite != null ? cost.cacheWrite / input : 1,
    modelPrice: null,
    enableGroups: ['default'],
  };
}

/** Fetch + replace the in-memory price table. Silent failure keeps old data. */
export async function syncModelsDevPrices(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const response = await fetch(MODELS_DEV_URL, {
      headers: { 'User-Agent': 'metapi-price-sync/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[models.dev] sync failed: HTTP ${response.status}`);
      return false;
    }
    const text = await response.text();
    const parsed = parseModelsDevPrices(text);
    if (!parsed || parsed.size === 0) {
      console.warn('[models.dev] sync failed: no usable prices in payload');
      return false;
    }
    modelsDevPrices = parsed;
    lastSyncAtMs = Date.now();
    console.info(`[models.dev] synced ${parsed.size} model prices`);
    return true;
  } catch (error) {
    console.warn(`[models.dev] sync failed: ${String(error)}`);
    return false;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function getModelsDevLastSyncAtMs(): number {
  return lastSyncAtMs;
}

export function getModelsDevPriceCount(): number {
  return modelsDevPrices.size;
}

/** Test-only: replace the in-memory price table (mirrors the __reset* pattern). */
export function __setModelsDevPricesForTests(prices: Map<string, ModelsDevCost>): void {
  modelsDevPrices = prices;
  lastSyncAtMs = Date.now();
}

/** Kick off an async boot sync and register the daily refresh task. */
export function startModelsDevPriceSync(): void {
  void syncModelsDevPrices();
  if (syncTask) return;
  syncTask = cron.schedule(SYNC_DAILY_CRON, () => {
    void syncModelsDevPrices();
  });
}
