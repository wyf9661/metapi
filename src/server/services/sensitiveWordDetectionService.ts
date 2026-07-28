/**
 * Global sensitive-word-detection (anti-probing) policy.
 *
 * Stored as a single row in the `settings` table under key `sensitiveWordDetectionEnabled`.
 * When the per-key column is null, this global default decides behavior.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

const SETTING_KEY = 'sensitiveWordDetectionEnabled';
const DEFAULT_ENABLED = true;

let cached: { value: boolean; loadedAt: number } | null = null;
const CACHE_TTL_MS = 5_000;

async function readSetting(): Promise<boolean> {
  try {
    const row = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, SETTING_KEY))
      .get();
    if (!row?.value) return DEFAULT_ENABLED;
    const parsed = JSON.parse(row.value);
    if (typeof parsed === 'boolean') return parsed;
    return DEFAULT_ENABLED;
  } catch {
    return DEFAULT_ENABLED;
  }
}

export async function resolveGlobalSensitiveWordDetection(): Promise<boolean> {
  const now = Date.now();
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await readSetting();
  cached = { value, loadedAt: now };
  return value;
}

export async function setGlobalSensitiveWordDetection(enabled: boolean): Promise<boolean> {
  const { upsertSetting } = await import('../db/upsertSetting.js');
  await upsertSetting(SETTING_KEY, enabled);
  cached = { value: enabled, loadedAt: Date.now() };
  return enabled;
}

export function __resetSensitiveWordDetectionCacheForTests(): void {
  cached = null;
}
