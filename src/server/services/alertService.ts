import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { sendNotification } from './notifyService.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { appendSessionTokenRebindHint } from './alertRules.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

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
 * Legacy name retained for callers/tests. The default is deliberately
 * "代理请求失败", not "代理全部失败". A caller may only claim all attempted
 * channels failed by explicitly passing outcome=all_attempted_channels_failed.
 */
export async function reportProxyAllFailed(params: ProxyFailureAlertParams) {
  const createdAt = formatUtcSqlDateTime(new Date());
  const formatted = formatProxyFailureAlert(params);
  await db.insert(schema.events).values({
    type: 'proxy',
    title: formatted.title,
    message: formatted.message,
    level: 'error',
    relatedType: 'route',
    createdAt,
  }).run();

  await sendNotification(
    formatted.title,
    formatted.message,
    'error',
  );
}
