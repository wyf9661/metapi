import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { sendNotification } from './notifyService.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { appendSessionTokenRebindHint } from './alertRules.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

/** Proxy midstream noise is high; suppress external push unless terminal multi-channel failure. */
export const PROXY_FAILURE_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;

const proxyFailureNotifyState = new Map<string, { lastSentAtMs: number; suppressedCount: number }>();

export async function reportTokenExpired(params: {
  accountId: number;
  username?: string | null;
  siteName?: string | null;
  detail?: string;
}) {
  const accountLabel = params.username || `ID:${params.accountId}`;
  const siteLabel = params.siteName || 'unknown-site';
  const detailText = params.detail ? appendSessionTokenRebindHint(params.detail) : '';
  const detail = detailText ? ` (${detailText})` : '';
  const createdAt = formatUtcSqlDateTime(new Date());

  await db.insert(schema.events).values({
    type: 'token',
    title: 'Token 已失效',
    message: `${accountLabel} @ ${siteLabel} 的 Token 无效或已过期${detail}`,
    level: 'error',
    relatedId: params.accountId,
    relatedType: 'account',
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
 * External push only for terminal multi-channel / empty-candidate outcomes.
 * Single-channel request_failed (common on flaky midstream) is events-only.
 */
export function shouldPushProxyFailureNotification(
  outcome: ProxyFailureOutcome = 'request_failed',
): boolean {
  return outcome === 'all_attempted_channels_failed' || outcome === 'no_available_channels';
}

/** Throttle key ignores exact reason text so the same model cannot flood. */
export function createProxyFailureNotifyKey(model: string, outcome: ProxyFailureOutcome): string {
  return `${outcome}||${String(model || '').trim().toLowerCase()}`;
}

export function evaluateProxyFailureNotifyThrottle(
  model: string,
  outcome: ProxyFailureOutcome,
  nowMs = Date.now(),
  cooldownMs = PROXY_FAILURE_NOTIFY_COOLDOWN_MS,
): { shouldSend: boolean; suppressedSinceLast: number } {
  if (cooldownMs <= 0) {
    return { shouldSend: true, suppressedSinceLast: 0 };
  }
  const key = createProxyFailureNotifyKey(model, outcome);
  const current = proxyFailureNotifyState.get(key);
  if (!current) {
    proxyFailureNotifyState.set(key, { lastSentAtMs: nowMs, suppressedCount: 0 });
    return { shouldSend: true, suppressedSinceLast: 0 };
  }
  if (nowMs - current.lastSentAtMs < cooldownMs) {
    current.suppressedCount += 1;
    proxyFailureNotifyState.set(key, current);
    return { shouldSend: false, suppressedSinceLast: 0 };
  }
  const suppressedSinceLast = current.suppressedCount;
  proxyFailureNotifyState.set(key, { lastSentAtMs: nowMs, suppressedCount: 0 });
  return { shouldSend: true, suppressedSinceLast };
}

export function __resetProxyFailureNotifyStateForTests(): void {
  proxyFailureNotifyState.clear();
}

/**
 * Legacy name retained for callers/tests.
 * Default title is "代理请求失败", not "代理全部失败".
 */
export async function reportProxyAllFailed(params: ProxyFailureAlertParams) {
  const createdAt = formatUtcSqlDateTime(new Date());
  const outcome = params.outcome || 'request_failed';
  const formatted = formatProxyFailureAlert({ ...params, outcome });

  await db.insert(schema.events).values({
    type: 'proxy',
    title: formatted.title,
    message: formatted.message,
    level: 'error',
    relatedType: 'route',
    createdAt,
  }).run();

  if (!shouldPushProxyFailureNotification(outcome)) {
    return;
  }

  const throttle = evaluateProxyFailureNotifyThrottle(params.model, outcome);
  if (!throttle.shouldSend) {
    return;
  }

  let message = formatted.message;
  if (throttle.suppressedSinceLast > 0) {
    message = `${message}\n\n[通知合并] 过去 ${Math.round(PROXY_FAILURE_NOTIFY_COOLDOWN_MS / 60_000)} 分钟内同模型同类告警已抑制 ${throttle.suppressedSinceLast} 次`;
  }

  await sendNotification(
    formatted.title,
    message,
    'error',
  );
}
