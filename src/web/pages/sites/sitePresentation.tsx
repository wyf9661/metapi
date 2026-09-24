/**
 * Presentation helpers and small display components for the sites page.
 * Extracted from Sites.tsx — pure move, zero behavior change. All functions
 * format a SiteRow/SubscriptionSummary or render a label.
 */

import { BanIcon, FileTextIcon, GlobeIcon, KeyIcon, SlidersIcon, UnlockIcon, UserIcon } from '../../components/MiniIcons.js';
import HoverPopover from '../../components/HoverPopover.js';

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

/**
 * Count of custom request headers configured on a site.
 *
 * The API hands the row `customHeaders` as the serialized JSON object ('' when
 * unset), so an empty object and malformed input both count as zero: the list
 * marker only has to answer "does this site send anything custom".
 */
export function countSiteCustomHeaders(customHeaders?: string | null): number {
  const raw = String(customHeaders ?? '').trim();
  if (!raw) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
    return Object.keys(parsed as Record<string, unknown>).length;
  } catch {
    return 0;
  }
}

/** Whether the site routes upstream traffic through its own outbound proxy. */
export function hasSiteOutboundProxy(proxyUrl?: string | null): boolean {
  return String(proxyUrl ?? '').trim().length > 0;
}

/**
 * Markers for configuration that silently changes how a site reaches upstream —
 * its own outbound proxy and custom request headers — which previously could
 * only be found by opening the editor site by site. Each marker labels itself
 * through HoverPopover, matching the connection markers in the same row.
 */
export function SiteOutboundFlags(props: {
  proxyUrl?: string | null;
  customHeaders?: string | null;
  customHeadersOverrideRequestHeaders?: boolean | null;
}) {
  const { proxyUrl, customHeaders, customHeadersOverrideRequestHeaders } = props;
  const hasProxy = hasSiteOutboundProxy(proxyUrl);
  const headerCount = countSiteCustomHeaders(customHeaders);
  if (!hasProxy && headerCount === 0) return null;

  return (
    <span className="sites-name-flags">
      {hasProxy ? (
        <span className="sites-name-flag">
          <HoverPopover content="已配置出站代理">
            <GlobeIcon size={12} />
          </HoverPopover>
        </span>
      ) : null}
      {headerCount > 0 ? (
        <span className="sites-name-flag">
          <HoverPopover content={`已配置自定义请求头 ${headerCount} 项${customHeadersOverrideRequestHeaders ? '，覆盖上游同名请求头' : ''}`}>
            <SlidersIcon size={12} />
          </HoverPopover>
        </span>
      ) : null}
    </span>
  );
}

export type SiteConnectionStatsLike = {
  sessions: number;
  apiKeys: number;
  tokens: number;
  oauth: number;
};

/** Per-key disabled-model summary carried by the sites list payload. */
export type SiteDisabledModelsSummary = {
  total: number;
  keys: Array<{ accountId: number; username: string | null; count: number }>;
};

/**
 * Connection counts as icon+number markers. Shared by the sites table row and
 * the mobile card so the two surfaces cannot drift apart.
 *
 * The icons replace the 👤/🔑/🎫/🔓 glyphs these counts used to be: emoji
 * presentation depends on the installed emoji font, so the markers rendered as
 * colour glyphs at a different optical size than the rest of the UI. Hidden
 * counts stay hidden — a zero count is not a signal.
 */
export function SiteConnectionStats(props: {
  stats?: SiteConnectionStatsLike | null;
  disabledModels?: SiteDisabledModelsSummary | null;
}) {
  const stats = props.stats;
  const disabled = props.disabledModels;
  // Disabled models belong to keys, so the marker reports how many keys carry a
  // list and how big each one is.
  const disabledLabel = disabled && disabled.keys.length > 0
    ? `禁用模型（按 key）：${disabled.keys
      .map((entry) => `${entry.username || `账号 ${entry.accountId}`} ${entry.count} 个`)
      .join('；')}`
    : '禁用模型';
  const markers = [
    { key: 'sessions', label: 'Session 账号', count: stats?.sessions || 0, Icon: UserIcon },
    { key: 'apiKeys', label: 'API Key', count: stats?.apiKeys || 0, Icon: KeyIcon },
    { key: 'tokens', label: '令牌', count: stats?.tokens || 0, Icon: FileTextIcon },
    { key: 'oauth', label: 'OAuth', count: stats?.oauth || 0, Icon: UnlockIcon },
    { key: 'disabledModels', label: disabledLabel, count: disabled?.total || 0, Icon: BanIcon },
  ].filter((marker) => marker.count > 0);

  if (markers.length === 0) {
    return <span style={{ color: 'var(--color-text-muted)' }}>-</span>;
  }

  return (
    <>
      {markers.map(({ key, label, count, Icon }) => (
        <span key={key} className="sites-conn-item">
          <HoverPopover content={label}>
            <Icon size={12} />
          </HoverPopover>
          {count}
        </span>
      ))}
    </>
  );
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

/**
 * Platform chip class for every surface that shows a platform (sites table,
 * detail header, announcements). Platform is a category, not a health signal:
 * colouring one-api green and claude amber made the table look like a status
 * board, so every platform uses the neutral chip. Kept in one place so the three
 * surfaces cannot drift apart again.
 */
export function platformBadgeClass(platform?: string | null): string {
  const key = String(platform || '').trim();
  return platformColors[key] || 'badge-muted';
}

export type OAuthProviderSiteInfo = {
  platform: string;
  siteUrl?: string | null;
};

/**
 * Whether a platform reaches the form via auto-detect or the OAuth flow rather
 * than the manual dropdown. Manual-entry platforms must never resolve to an
 * OAuth provider — that prefills the editor with the provider's own upstream URL.
 */
export function isOauthFlowPlatform(platform?: string | null): boolean {
  const normalized = String(platform || '').trim().toLowerCase();
  if (!normalized) return false;
  return !SITE_PLATFORM_OPTIONS.some((option) => option.value === normalized);
}

/**
 * The OAuth provider a platform maps to, or null for manual-entry platforms.
 * One source of truth for the editor's selected-provider lookup and the
 * platform-select prefill guard, so the two cannot drift apart again.
 */
export function findOauthProviderForPlatform<T extends OAuthProviderSiteInfo>(
  platform: string | null | undefined,
  providers: ReadonlyArray<T>,
): T | null {
  if (!isOauthFlowPlatform(platform)) return null;
  const normalized = String(platform || '').trim().toLowerCase();
  return providers.find((provider) => provider.platform === normalized) || null;
}

export const platformColors: Record<string, string> = {
  'new-api': 'badge-muted',
  'one-api': 'badge-muted',
  sub2api: 'badge-muted',
  metapi: 'badge-muted',
  openai: 'badge-muted',
  codex: 'badge-muted',
  claude: 'badge-muted',
  gemini: 'badge-muted',
  cliproxyapi: 'badge-muted',
};

export const SITE_PLATFORM_OPTIONS = [
  { value: '', label: '平台类型（可自动检测）' },
  { value: 'new-api', label: 'new-api', description: '聚合面板，多渠道统一管理' },
  { value: 'one-api', label: 'one-api', description: '经典聚合面板，通用 OpenAI 中转' },
  { value: 'sub2api', label: 'sub2api', description: '订阅式中转面板，可同步套餐与余额' },
  { value: 'metapi', label: 'metapi', description: '另一个 MetAPI 实例，填下游 key 同步余额与用量' },
  { value: 'openai', label: 'openai', description: '通用 OpenAI 兼容接口，手填 Base URL' },
  { value: 'claude', label: 'claude', description: 'Claude / Anthropic 接口，手填 Base URL + API Key' },
  { value: 'gemini', label: 'gemini', description: '通用 Gemini / Google AI 兼容接口' },
];
