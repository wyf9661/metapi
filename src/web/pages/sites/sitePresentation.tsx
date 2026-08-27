/**
 * Presentation helpers and small display components for the sites page.
 * Extracted from Sites.tsx — pure move, zero behavior change. All functions
 * format a SiteRow/SubscriptionSummary or render a label.
 */

export type SiteSubscriptionSummary = {
  activeCount: number;
  planNames?: string[];
  totalRemainingUsd?: number | null;
  totalUsedUsd?: number;
  totalMonthlyLimitUsd?: number | null;
  nextExpiresAt?: string | null;
};

export type SiteRowLike = {
  apiEndpoints?: Array<{
    id?: number;
    url: string;
    enabled?: boolean;
    sortOrder?: number;
    cooldownUntil?: string | null;
    lastFailureReason?: string | null;
  }> | null;
};

export function getConfiguredSiteApiEndpoints(site?: Pick<SiteRowLike, 'apiEndpoints'> | null) {
  return Array.isArray(site?.apiEndpoints)
    ? site.apiEndpoints.filter((item) => typeof item?.url === 'string' && item.url.trim())
    : [];
}

export function formatUsd(value?: number | null): string {
  return `$${(value || 0).toFixed(2)}`;
}

export function resolveSiteCreatedSessionLabel(platform?: string | null): string {
  const normalized = String(platform || '').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'gemini-cli' || normalized === 'antigravity') return '添加 OAuth 连接';
  return '添加账号（用户名密码登录）';
}

/**
 * 跳转到站点对应的连接补全流程。
 */
export function buildSiteConnectionSearchParams(input: {
  siteId: number;
  initializationPresetId?: string | null;
}) {
  const params = new URLSearchParams({
    create: '1',
    siteId: String(input.siteId),
  });
  if (input.initializationPresetId) {
    params.set('initPreset', input.initializationPresetId);
  }
  return params;
}

export function formatSubscriptionDate(value?: string | null): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toISOString().slice(0, 10);
}

export function formatRemainingDuration(value?: string | null): string | null {
  if (!value) return null;
  const targetMs = Date.parse(value);
  if (!Number.isFinite(targetMs)) return null;
  const deltaMs = targetMs - Date.now();
  if (deltaMs <= 0) return '已到期';

  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (deltaMs >= dayMs) return `剩余${Math.ceil(deltaMs / dayMs)}天`;
  if (deltaMs >= hourMs) return `剩余${Math.ceil(deltaMs / hourMs)}小时`;
  if (deltaMs >= minuteMs) return `剩余${Math.ceil(deltaMs / minuteMs)}分钟`;
  return `剩余${Math.max(1, Math.ceil(deltaMs / 1000))}秒`;
}

export function buildSubscriptionInlineValue(summary?: SiteSubscriptionSummary | null): string | null {
  if (!summary) return null;
  const remainingValue = typeof summary.totalRemainingUsd === 'number' && Number.isFinite(summary.totalRemainingUsd)
    ? formatUsd(summary.totalRemainingUsd)
    : '--';
  const usedValue = formatUsd(summary.totalUsedUsd);
  const remainingDuration = formatRemainingDuration(summary.nextExpiresAt);
  const remainingSuffix = remainingDuration ? `（${remainingDuration}）` : '';
  if (usedValue === '$0.00' && remainingValue === '--' && !remainingSuffix) return null;
  return `${remainingValue}${remainingSuffix}`;
}

export function buildSubscriptionTooltip(summary?: SiteSubscriptionSummary | null): string | null {
  if (!summary) return null;
  const parts: string[] = [];
  if (summary.activeCount > 0) parts.push(`生效订阅 ${summary.activeCount} 个`);

  const planNames = Array.isArray(summary.planNames)
    ? summary.planNames.filter((item) => typeof item === 'string' && item.trim())
    : [];
  if (planNames.length > 0) parts.push(`套餐 ${planNames.join(' / ')}`);

  if (typeof summary.totalRemainingUsd === 'number' && Number.isFinite(summary.totalRemainingUsd)) {
    parts.push(`订阅余额 ${formatUsd(summary.totalRemainingUsd)}`);
  }
  parts.push(`已用 ${formatUsd(summary.totalUsedUsd)}`);

  if (typeof summary.totalMonthlyLimitUsd === 'number' && Number.isFinite(summary.totalMonthlyLimitUsd)) {
    parts.push(`总额度 ${formatUsd(summary.totalMonthlyLimitUsd)}`);
  }

  const remainingDuration = formatRemainingDuration(summary.nextExpiresAt);
  if (remainingDuration) parts.push(remainingDuration);

  if (summary.nextExpiresAt) parts.push(`到期 ${formatSubscriptionDate(summary.nextExpiresAt)}`);

  return parts.join(' | ');
}

export function SiteBalanceDisplay(props: {
  balance?: number | null;
  todayReward?: number | null;
  todaySpend?: number | null;
  summary?: SiteSubscriptionSummary | null;
  align?: 'start' | 'end';
}) {
  const { balance, todayReward, todaySpend, summary, align = 'start' } = props;
  const walletBalanceText = formatUsd(balance);
  const subscriptionValue = buildSubscriptionInlineValue(summary);
  const tooltip = buildSubscriptionTooltip(summary);
  const reward = todayReward || 0;
  const spend = todaySpend || 0;

  return (
    <div
      className={`site-balance-inline ${align === 'end' ? 'align-end' : ''}`.trim()}
    >
      <span className="site-balance-primary">{walletBalanceText}</span>
      {subscriptionValue ? (
        <>
          <span className="site-balance-divider">/</span>
          <span
            className="site-balance-subscription"
            data-tooltip={tooltip || undefined}
            data-tooltip-align={align === 'end' ? 'end' : 'start'}
            data-tooltip-side="top"
            tabIndex={tooltip ? 0 : undefined}
          >
            {subscriptionValue}
          </span>
        </>
      ) : null}
      {reward > 0 ? (
        <span className="site-balance-reward" style={{ marginLeft: 4 }}>
          +{reward.toFixed(2)}
        </span>
      ) : null}
      {spend > 0 ? (
        <span className="site-balance-spend" style={{ marginLeft: 4 }}>
          -{spend.toFixed(2)}
        </span>
      ) : null}
    </div>
  );
}

export const platformColors: Record<string, string> = {
  'new-api': 'badge-info',
  'one-api': 'badge-success',
  sub2api: 'badge-muted',
  openai: 'badge-success',
  codex: 'badge-success',
  claude: 'badge-warning',
  gemini: 'badge-info',
  cliproxyapi: 'badge-info',
};

export const SITE_PLATFORM_OPTIONS = [
  { value: '', label: '平台类型（可自动检测）' },
  { value: 'new-api', label: 'new-api', description: '聚合面板，适合多渠道统一管理' },
  { value: 'one-api', label: 'one-api', description: '经典聚合面板，常见于通用 OpenAI 中转' },
  { value: 'sub2api', label: 'sub2api', description: '订阅式中转面板，可同步套餐与余额信息' },
  { value: 'openai', label: 'openai', description: '通用 OpenAI 兼容接口，手填 Base URL 即可' },
  { value: 'claude', label: 'claude', description: 'Claude / Anthropic 接口，手填 Base URL + API Key' },
  { value: 'gemini', label: 'gemini', description: '通用 Gemini / Google AI 兼容接口' },
];
