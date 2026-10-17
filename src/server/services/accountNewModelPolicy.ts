/**
 * Per-account policy for models that show up upstream AFTER the user curated the
 * account's model list.
 *
 * The per-key disabled list is a blacklist: a model that is not in it stays
 * enabled, so an upstream release silently added new models to every curated
 * key — they appeared in /v1/models, got probed and could be routed even though
 * the user had deliberately selected only a few models. Accounts can now pick:
 *
 *   auto    (default) — new models are enabled as before;
 *   disable           — model names that were never seen before are added to the
 *                       disabled list automatically and stay off until the user
 *                       enables them manually.
 *
 * "Seen before" is tracked in extra_config.knownModels, refreshed after every
 * successful discovery, so only genuinely new names are disabled. Switching the
 * policy on seeds the baseline with the current model set: nothing that already
 * exists is touched retroactively.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getNewModelPolicyFromExtraConfig } from './accountExtraConfig.js';
import { invalidateSiteProxyCache } from './siteProxy.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';

export type AccountNewModelPolicy = 'auto' | 'disable';

/** New models are enabled unless the account opted into auto-disable. */
export const DEFAULT_NEW_MODEL_POLICY: AccountNewModelPolicy = 'auto';

/** Cap the baseline so a 5k-model key cannot bloat extra_config. */
const KNOWN_MODELS_LIMIT = 2_000;

function parseExtraConfig(extraConfig: string | null | undefined): Record<string, unknown> {
  if (!extraConfig) return {};
  if (typeof extraConfig !== 'string') {
    return typeof extraConfig === 'object' ? (extraConfig as Record<string, unknown>) : {};
  }
  try {
    const parsed = JSON.parse(extraConfig);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readKnownModels(extraConfig: string | null | undefined): Set<string> | null {
  const raw = parseExtraConfig(extraConfig).knownModels;
  if (!Array.isArray(raw)) return null;
  const names = raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().toLowerCase());
  return new Set(names);
}

function buildExtraConfigWithUpdates(
  extraConfig: string | null | undefined,
  patch: Record<string, unknown>,
): string {
  return JSON.stringify({ ...parseExtraConfig(extraConfig), ...patch });
}

async function writeKnownModels(
  accountId: number,
  extraConfig: string | null | undefined,
  modelNames: string[],
): Promise<void> {
  const snapshot = modelNames.slice(0, KNOWN_MODELS_LIMIT);
  await db.update(schema.accounts)
    .set({
      extraConfig: buildExtraConfigWithUpdates(extraConfig, { knownModels: snapshot }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.accounts.id, accountId))
    .run();
}

export type NewModelPolicyResult = {
  policy: AccountNewModelPolicy;
  /** Names that were auto-disabled in this pass. */
  disabled: string[];
  /** True when the baseline was just seeded (first pass / policy switch). */
  seeded: boolean;
};

/**
 * Apply the account's new-model policy. Runs after a successful model refresh:
 * newly discovered names are added to the per-key disabled list when the policy
 * is `disable`, then the baseline is advanced to the current model set.
 */
export async function applyNewModelPolicyForAccount(
  accountId: number,
): Promise<NewModelPolicyResult | null> {
  const account = await db.select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) return null;

  const policy = getNewModelPolicyFromExtraConfig(account.extraConfig);
  const rows = await db.select({ modelName: schema.modelAvailability.modelName })
    .from(schema.modelAvailability)
    .where(eq(schema.modelAvailability.accountId, accountId))
    .all();
  const currentNames = rows.map((row) => String(row.modelName || '').trim()).filter(Boolean);

  const known = readKnownModels(account.extraConfig);
  if (!known) {
    // First pass for this account (or policy just switched on): everything that
    // already exists is treated as known, so nothing is disabled retroactively.
    await writeKnownModels(accountId, account.extraConfig, currentNames);
    return { policy, disabled: [], seeded: true };
  }

  let disabled: string[] = [];
  if (policy === 'disable') {
    const fresh = currentNames.filter((name) => !known.has(name.toLowerCase()));
    if (fresh.length > 0) {
      await db.insert(schema.siteDisabledModels)
        .values(fresh.map((modelName) => ({
          siteId: account.siteId,
          accountId,
          modelName,
        })))
        .onConflictDoNothing()
        .run();
      invalidateSiteProxyCache();
      invalidateTokenRouterCache();
      disabled = fresh;
    }
  }

  await writeKnownModels(accountId, account.extraConfig, currentNames);
  return { policy, disabled, seeded: false };
}

/** Persist the policy; switching to `disable` seeds the baseline immediately. */
export async function setAccountNewModelPolicy(
  accountId: number,
  policy: AccountNewModelPolicy,
): Promise<boolean> {
  const account = await db.select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) return false;

  const rows = await db.select({ modelName: schema.modelAvailability.modelName })
    .from(schema.modelAvailability)
    .where(eq(schema.modelAvailability.accountId, accountId))
    .all();
  const currentNames = rows.map((row) => String(row.modelName || '').trim()).filter(Boolean);
  const known = readKnownModels(account.extraConfig);

  const patch: Record<string, unknown> = { newModelPolicy: policy };
  // Seed the baseline the first time the policy is configured (or when turning
  // auto-disable on for an account that never had a snapshot).
  if (policy === 'disable' && !known) {
    patch.knownModels = currentNames.slice(0, KNOWN_MODELS_LIMIT);
  }

  await db.update(schema.accounts)
    .set({
      extraConfig: buildExtraConfigWithUpdates(account.extraConfig, patch),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.accounts.id, accountId))
    .run();
  return true;
}
