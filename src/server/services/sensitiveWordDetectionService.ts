/**
 * Global sensitive-word-detection (anti-probing) policy.
 *
 * Stored in the `settings` table:
 *   - `sensitiveWordDetectionEnabled` (boolean, default true): global on/off.
 *   - `antiProbeMinTextLength` (number, default 8): messages shorter than this
 *     (after trimming) are treated as probes unless they are legitimate
 *     follow-ups in an ongoing conversation.
 *
 * When the per-key column is null, these global defaults decide behavior.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

const ENABLED_SETTING_KEY = 'sensitiveWordDetectionEnabled';
const MIN_TEXT_LENGTH_SETTING_KEY = 'antiProbeMinTextLength';
const DEFAULT_ENABLED = true;
const DEFAULT_MIN_TEXT_LENGTH = 8;
const MINIMUM_MIN_TEXT_LENGTH = 1;
const MAXIMUM_MIN_TEXT_LENGTH = 64;

const CACHE_TTL_MS = 5_000;

type BooleanCacheEntry = { value: boolean; loadedAt: number };
type NumberCacheEntry = { value: number; loadedAt: number };

let enabledCache: BooleanCacheEntry | null = null;
let minTextLengthCache: NumberCacheEntry | null = null;

async function readSettingValue(key: string): Promise<unknown> {
  const row = await db.select().from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function clampAntiProbeMinTextLength(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIN_TEXT_LENGTH;
  return Math.max(MINIMUM_MIN_TEXT_LENGTH, Math.min(MAXIMUM_MIN_TEXT_LENGTH, Math.trunc(value)));
}

export async function resolveGlobalSensitiveWordDetection(): Promise<boolean> {
  const now = Date.now();
  if (enabledCache && now - enabledCache.loadedAt < CACHE_TTL_MS) {
    return enabledCache.value;
  }
  let value = DEFAULT_ENABLED;
  try {
    const parsed = await readSettingValue(ENABLED_SETTING_KEY);
    if (typeof parsed === 'boolean') value = parsed;
  } catch {
    // fall back to default
  }
  enabledCache = { value, loadedAt: now };
  return value;
}

export async function setGlobalSensitiveWordDetection(enabled: boolean): Promise<boolean> {
  const { upsertSetting } = await import('../db/upsertSetting.js');
  await upsertSetting(ENABLED_SETTING_KEY, enabled);
  enabledCache = { value: enabled, loadedAt: Date.now() };
  return enabled;
}

export async function resolveAntiProbeMinTextLength(): Promise<number> {
  const now = Date.now();
  if (minTextLengthCache && now - minTextLengthCache.loadedAt < CACHE_TTL_MS) {
    return minTextLengthCache.value;
  }
  let value = DEFAULT_MIN_TEXT_LENGTH;
  try {
    const parsed = await readSettingValue(MIN_TEXT_LENGTH_SETTING_KEY);
    if (typeof parsed === 'number') value = clampAntiProbeMinTextLength(parsed);
  } catch {
    // fall back to default
  }
  minTextLengthCache = { value, loadedAt: now };
  return value;
}

export async function setAntiProbeMinTextLength(value: number): Promise<number> {
  const normalized = clampAntiProbeMinTextLength(value);
  const { upsertSetting } = await import('../db/upsertSetting.js');
  await upsertSetting(MIN_TEXT_LENGTH_SETTING_KEY, normalized);
  minTextLengthCache = { value: normalized, loadedAt: Date.now() };
  return normalized;
}

export function __resetSensitiveWordDetectionCacheForTests(): void {
  enabledCache = null;
  minTextLengthCache = null;
}