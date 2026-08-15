import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { getOauthInfoFromAccount, buildStoredOauthStateFromAccount } from './oauthAccount.js';
import { advanceRefreshBackoff, isRefreshBackoffActive } from '../refreshBackoff.js';
import { mergeAccountExtraConfig } from '../accountExtraConfig.js';
import { refreshOauthAccessTokenSingleflight } from './refreshSingleflight.js';

const OAUTH_REFRESH_SCHEDULER_INTERVAL_MS = 60_000;
const DEFAULT_OAUTH_REFRESH_LEAD_MS = 5 * 60 * 1000;
const OAUTH_REFRESH_LEAD_BY_PROVIDER: Record<string, number> = {
  codex: 5 * 24 * 60 * 60 * 1000,
  claude: 4 * 60 * 60 * 1000,
  'gemini-cli': 5 * 60 * 1000,
  antigravity: 5 * 60 * 1000,
};

let oauthRefreshSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let oauthRefreshPassInFlight: Promise<void> | null = null;

function clearOauthRefreshSchedulerTimer(): void {
  if (!oauthRefreshSchedulerTimer) return;
  clearInterval(oauthRefreshSchedulerTimer);
  oauthRefreshSchedulerTimer = null;
}

function normalizeProvider(provider?: string | null): string {
  return String(provider || '').trim().toLowerCase();
}

function getOauthRefreshLeadMs(provider?: string | null): number {
  const normalizedProvider = normalizeProvider(provider);
  return OAUTH_REFRESH_LEAD_BY_PROVIDER[normalizedProvider] ?? DEFAULT_OAUTH_REFRESH_LEAD_MS;
}

function shouldRefreshOauthAccount(input: {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  nowMs: number;
}): boolean {
  if ((input.account.status || 'active') !== 'active') return false;
  if ((input.site.status || 'active') !== 'active') return false;

  const oauth = getOauthInfoFromAccount(input.account);
  if (!oauth?.refreshToken) return false;
  if (!(typeof oauth.tokenExpiresAt === 'number' && Number.isFinite(oauth.tokenExpiresAt) && oauth.tokenExpiresAt > 0)) {
    return false;
  }

  // Skip accounts whose last refresh attempt failed within the backoff window.
  // A persistent upstream failure must not turn the 60s scheduler into an
  // infinite retry loop against the provider.
  if (isRefreshBackoffActive(oauth.refreshRetryAtMs, input.nowMs)) {
    return false;
  }

  return oauth.tokenExpiresAt - input.nowMs <= getOauthRefreshLeadMs(oauth.provider);
}

function buildOauthBackoffExtraConfigPatch(
  account: typeof schema.accounts.$inferSelect,
  nowMs: number,
): Record<string, unknown> {
  const oauth = getOauthInfoFromAccount(account);
  const { failCount, retryAtMs } = advanceRefreshBackoff(oauth?.refreshFailCount, nowMs);
  const nextOauth = buildStoredOauthStateFromAccount(account, {
    refreshFailCount: failCount,
    refreshRetryAtMs: retryAtMs,
  });
  return { oauth: nextOauth };
}

function buildOauthClearBackoffExtraConfigPatch(
  account: typeof schema.accounts.$inferSelect,
): Record<string, unknown> {
  const nextOauth = buildStoredOauthStateFromAccount(account, {
    refreshFailCount: 0,
    refreshRetryAtMs: undefined,
  });
  return { oauth: nextOauth };
}

export async function executeOauthTokenAutoRefreshPass(input: {
  nowMs?: number;
} = {}) {
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs)
    ? input.nowMs
    : Date.now();
  const rows = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const oauthRows = rows.filter((row: any) => !!getOauthInfoFromAccount(row.accounts));
  const refreshedAccountIds: number[] = [];
  const failedAccountIds: number[] = [];
  let skipped = 0;

  for (const row of oauthRows) {
    if (!shouldRefreshOauthAccount({
      account: row.accounts,
      site: row.sites,
      nowMs,
    })) {
      skipped += 1;
      continue;
    }

    try {
      await refreshOauthAccessTokenSingleflight(row.accounts.id);
      refreshedAccountIds.push(row.accounts.id);
      // Refresh succeeded: clear any previously recorded failure backoff so a
      // subsequent failure starts from a fresh backoff schedule.
      const oauth = getOauthInfoFromAccount(row.accounts);
      if (oauth?.refreshFailCount || oauth?.refreshRetryAtMs) {
        await db.update(schema.accounts).set({
          extraConfig: mergeAccountExtraConfig(
            row.accounts.extraConfig,
            buildOauthClearBackoffExtraConfigPatch(row.accounts),
          ),
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.accounts.id, row.accounts.id)).run();
      }
    } catch (error) {
      failedAccountIds.push(row.accounts.id);
      console.warn(
        `[oauth-refresh] failed to refresh account ${row.accounts.id}: ${(error as Error)?.message || 'unknown error'}`,
      );
      // Persist the failure so the scheduler backs off instead of retrying
      // every 60s against a provider endpoint that keeps rejecting the request.
      await db.update(schema.accounts).set({
        extraConfig: mergeAccountExtraConfig(
          row.accounts.extraConfig,
          buildOauthBackoffExtraConfigPatch(row.accounts, nowMs),
        ),
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.accounts.id, row.accounts.id)).run();
    }
  }

  return {
    scanned: oauthRows.length,
    refreshed: refreshedAccountIds.length,
    failed: failedAccountIds.length,
    skipped,
    refreshedAccountIds,
    failedAccountIds,
  };
}

async function runScheduledOauthRefreshPass(): Promise<void> {
  if (oauthRefreshPassInFlight) {
    return oauthRefreshPassInFlight;
  }

  oauthRefreshPassInFlight = executeOauthTokenAutoRefreshPass()
    .then(() => undefined)
    .catch((error) => {
      console.warn(`[oauth-refresh] scheduled pass failed: ${(error as Error)?.message || 'unknown error'}`);
    })
    .finally(() => {
      oauthRefreshPassInFlight = null;
    });

  return oauthRefreshPassInFlight;
}

export function startOauthTokenRefreshScheduler(intervalMs = OAUTH_REFRESH_SCHEDULER_INTERVAL_MS) {
  clearOauthRefreshSchedulerTimer();

  const safeIntervalMs = Math.max(OAUTH_REFRESH_SCHEDULER_INTERVAL_MS, Math.trunc(intervalMs || 0));
  void runScheduledOauthRefreshPass();
  oauthRefreshSchedulerTimer = setInterval(() => {
    void runScheduledOauthRefreshPass();
  }, safeIntervalMs);
  oauthRefreshSchedulerTimer.unref?.();

  return {
    enabled: true,
    intervalMs: safeIntervalMs,
  };
}

export async function stopOauthTokenRefreshScheduler() {
  clearOauthRefreshSchedulerTimer();
  if (oauthRefreshPassInFlight) {
    await oauthRefreshPassInFlight;
  }
}

export async function __resetOauthTokenRefreshSchedulerForTests() {
  await stopOauthTokenRefreshScheduler();
  oauthRefreshPassInFlight = null;
}
