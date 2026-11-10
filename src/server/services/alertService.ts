import { db, schema } from '../db/index.js';
import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import { sendNotification } from './notifyService.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { appendSessionTokenRebindHint } from './alertRules.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { formatNoChannelDiagnostic, getNoChannelDiagnostic } from './proxyNoChannelDiagnostics.js';

/**
 * Token-expiry sightings need confirmation before full alerting. A single
 * 401/token-looking error is often transient (upstream WAF, gateway default
 * wording, rate-limit shield) and the account recovers on the next refresh.
 * Only a second hit within the window triggers the full side effects
 * (event + expired status + external push). Any successful balance refresh or
 * proxy request clears the sightings.
 */
export const TOKEN_EXPIRED_CONFIRM_REQUIRED = 2;
export const TOKEN_EXPIRED_CONFIRM_WINDOW_MS = 30 * 60 * 1000;

const tokenExpiredSightingState = new Map<string, { count: number; firstSeenAtMs: number }>();

function tokenExpiredSightingKey(accountId: number, proxyTokenId?: number | null): string {
  const credential = proxyTokenId === undefined ? 'management' : `proxy:${proxyTokenId ?? 'account'}`;
  return `${accountId}:${credential}`;
}

// shortcut: recent success defers expiry for 10 minutes; prefer reliable error provenance when available.
const TOKEN_EXPIRED_SUCCESS_EVIDENCE_WINDOW_MS = 10 * 60 * 1000;

async function credentialServedRequestRecently(
  accountId: number,
  tokenId: number | null,
  nowMs = Date.now(),
): Promise<boolean> {
  const since = formatUtcSqlDateTime(new Date(nowMs - TOKEN_EXPIRED_SUCCESS_EVIDENCE_WINDOW_MS));
  const row = await db
    .select({ id: schema.proxyLogs.id })
    .from(schema.proxyLogs)
    .where(and(
      eq(schema.proxyLogs.accountId, accountId),
      tokenId == null ? isNull(schema.proxyLogs.tokenId) : eq(schema.proxyLogs.tokenId, tokenId),
      eq(schema.proxyLogs.status, 'success'),
      gte(schema.proxyLogs.createdAt, since),
      lte(schema.proxyLogs.createdAt, formatUtcSqlDateTime(new Date(nowMs))),
    ))
    .limit(1)
    .get();
  return !!row;
}

export function noteTokenExpiredSighting(
  accountId: number,
  nowMs = Date.now(),
  proxyTokenId?: number | null,
): boolean {
  const key = tokenExpiredSightingKey(accountId, proxyTokenId);
  const current = tokenExpiredSightingState.get(key);
  if (!current || nowMs - current.firstSeenAtMs > TOKEN_EXPIRED_CONFIRM_WINDOW_MS) {
    tokenExpiredSightingState.set(key, { count: 1, firstSeenAtMs: nowMs });
    return false;
  }
  const nextCount = current.count + 1;
  if (nextCount >= TOKEN_EXPIRED_CONFIRM_REQUIRED) {
    tokenExpiredSightingState.delete(key);
    return true;
  }
  tokenExpiredSightingState.set(key, { count: nextCount, firstSeenAtMs: current.firstSeenAtMs });
  return false;
}

export function resetTokenExpiredSightings(accountId: number, proxyTokenId?: number | null): void {
  tokenExpiredSightingState.delete(tokenExpiredSightingKey(accountId, proxyTokenId));
}

export function __resetTokenExpiredSightingStateForTests(): void {
  tokenExpiredSightingState.clear();
}

export async function reportTokenExpired(
  params: {
    accountId: number;
    siteId: number;
    username?: string | null;
    siteName?: string | null;
    detail?: string;
    /** Present only for proxy failures; null denotes the account-level API key. */
    proxyTokenId?: number | null;
  },
  /**
   * Optional live credential check, provided by callers that can perform a real
   * request (e.g. balanceService). When it resolves successfully the sighting is
   * treated as spurious: the account auto-recovers (status back to active,
   * health back to healthy) and nothing is pushed.
   */
  verify?: () => Promise<unknown> | unknown,
) {
  const accountLabel = params.username || `ID:${params.accountId}`;
  const siteLabel = params.siteName || 'unknown-site';
  const detailText = params.detail ? appendSessionTokenRebindHint(params.detail) : '';
  const detail = detailText ? ` (${detailText})` : '';

  // Proxy successes cannot validate the separate session token used by check-in/balance.
  if (!verify && params.proxyTokenId !== undefined) {
    try {
      if (await credentialServedRequestRecently(params.accountId, params.proxyTokenId)) {
        resetTokenExpiredSightings(params.accountId, params.proxyTokenId);
        return;
      }
    } catch (error) {
      console.warn('[alert] failed to read proxy credential success evidence', params.accountId, error);
    }
  }

  // First hit within the window is treated as a suspected transient failure:
  // only downgrade runtime health, do not mark the account expired or push.
  if (!noteTokenExpiredSighting(params.accountId, Date.now(), params.proxyTokenId)) {
    setAccountRuntimeHealth(params.accountId, {
      state: 'degraded',
      reason: detailText ? `连接状态异常：${detailText}` : '连接状态异常',
      source: 'auth',
    });
    return;
  }

  // Confirmed by a second sighting, but before committing to the full alert,
  // run the caller's live credential check if one was provided. A successful
  // check proves the token still works, so recover silently instead of
  // marking the account expired and pushing.
  if (verify) {
    try {
      const verified = await verify();
      const skipped = !!verified
        && typeof verified === 'object'
        && 'skipped' in (verified as Record<string, unknown>)
        && (verified as { skipped?: unknown }).skipped === true;
      if (verified && !skipped) {
        await db.update(schema.accounts)
          .set({ status: 'active', updatedAt: new Date().toISOString() })
          .where(eq(schema.accounts.id, params.accountId))
          .run();
        setAccountRuntimeHealth(params.accountId, {
          state: 'healthy',
          reason: '令牌验证通过',
          source: 'balance',
        });
        resetTokenExpiredSightings(params.accountId);
        return;
      }
    } catch {
      // Re-verify failed, proceed with the full alert.
    }
  }

  const createdAt = formatUtcSqlDateTime(new Date());

  await db.insert(schema.events).values({
    type: 'token',
    title: 'Token 已失效',
    message: `${accountLabel} @ ${siteLabel} 的 Token 无效或已过期${detail}`,
    level: 'error',
    relatedId: params.siteId,
    relatedType: 'site',
    createdAt,
  }).run();

  await db.update(schema.accounts).set({
    status: 'expired',
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.accounts.id, params.accountId)).run();

  setAccountRuntimeHealth(params.accountId, {
    state: 'unhealthy',
    reason: detailText ? `访问令牌失效：${detailText}` : '访问令牌失效',
    source: 'auth',
  });

  await sendNotification(
    'Token 已失效',
    `${accountLabel} @ ${siteLabel} 的 Token 无效或已过期${detail}`,
    'error',
  );
}

export type ProxyFailureOutcome =
  | 'request_failed'
  | 'all_attempted_channels_failed'
  | 'no_available_channels';

export type ProxyFailureAlertParams = {
  model: string;
  reason: string;
  outcome?: ProxyFailureOutcome;
  attemptedChannels?: number;
  configuredAttempts?: number;
  retryBudgetExhausted?: boolean;
};

export function formatProxyFailureAlert(params: ProxyFailureAlertParams): {
  title: string;
  message: string;
} {
  const outcome = params.outcome || 'request_failed';
  const title = outcome === 'all_attempted_channels_failed'
    ? '已尝试渠道均失败'
    : outcome === 'no_available_channels'
      ? '代理无可用渠道'
      : '代理请求失败';
  const details = [
    `模型=${params.model}`,
    `原因=${params.reason}`,
  ];
  if (typeof params.attemptedChannels === 'number' && params.attemptedChannels >= 0) {
    const configured = typeof params.configuredAttempts === 'number' && params.configuredAttempts > 0
      ? `/${params.configuredAttempts}`
      : '';
    details.push(`已尝试=${params.attemptedChannels}${configured}`);
  }
  if (params.retryBudgetExhausted) {
    details.push('终止=故障转移预算耗尽');
  }
  return { title, message: details.join(', ') };
}

/**
 * Legacy name retained for callers/tests.
 * Default title is "代理请求失败", not "代理全部失败".
 *
 * Proxy failure alerts are events-only: recorded in the events table, never
 * pushed to DingTalk/email/bark (the previous external push was too noisy for
 * group bots; the push path and its throttle were removed — reintroduce a
 * configurable push in notifyService if ever needed again).
 */
export async function reportProxyAllFailed(params: ProxyFailureAlertParams) {
  const createdAt = formatUtcSqlDateTime(new Date());
  const outcome = params.outcome || 'request_failed';
  const formatted = formatProxyFailureAlert({ ...params, outcome });
  // Attach the selection-time exclusion reasons when the router just failed to
  // find a channel for this model. Without them the event only says "no
  // available channels", and the condition that emptied the pool (a cooldown, a
  // status flip, an unusable token) is usually gone by the time it is read.
  // Attribution is bounded by the diagnostic's own short TTL.
  const noChannelDiagnostic = getNoChannelDiagnostic(params.model);
  const message = noChannelDiagnostic
    ? `${formatted.message}, ${formatNoChannelDiagnostic(noChannelDiagnostic)}`
    : formatted.message;

  await db.insert(schema.events).values({
    type: 'proxy',
    title: formatted.title,
    message,
    level: 'error',
    relatedType: 'route',
    createdAt,
  }).run();
}
