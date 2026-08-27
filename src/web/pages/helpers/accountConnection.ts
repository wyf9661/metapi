export function resolveAccountCredentialMode(account: any): 'session' | 'apikey' {
  const rawMode = String(account?.credentialMode || '').trim().toLowerCase();
  if (rawMode === 'apikey') return 'apikey';
  if (rawMode === 'session') return 'session';
  if (typeof account?.capabilities?.proxyOnly === 'boolean') {
    return account.capabilities.proxyOnly ? 'apikey' : 'session';
  }
  return typeof account?.accessToken === 'string' && account.accessToken.trim()
    ? 'session'
    : 'apikey';
}

export function parsePositiveInt(input: string | null): number {
  const normalized = String(input || '').trim();
  if (!/^\d+$/.test(normalized)) return 0;
  const value = Number.parseInt(normalized, 10);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

export function isTruthyFlag(input: string | null): boolean {
  if (!input) return false;
  const normalized = input.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

// ── OAuth account info helpers ─────────────────────────────────────────────

export type OauthAccountQuotaWindow = {
  supported: boolean;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  message?: string | null;
};

export type OauthAccountInfo = {
  provider: string;
  email: string;
  planType: string;
  quota: {
    fiveHour: OauthAccountQuotaWindow | null;
    sevenDay: OauthAccountQuotaWindow | null;
  } | null;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseAccountExtraConfigJson(account: any): Record<string, any> {
  try {
    return JSON.parse(account?.extraConfig || '{}') || {};
  } catch {
    return {};
  }
}

function normalizeQuotaWindowState(window: any): OauthAccountQuotaWindow | null {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return null;
  if (typeof window.supported !== 'boolean') return null;
  const result: OauthAccountQuotaWindow = { supported: window.supported };
  if (typeof window.used === 'number' && Number.isFinite(window.used)) {
    result.used = window.used;
  }
  if (typeof window.limit === 'number' && Number.isFinite(window.limit)) {
    result.limit = window.limit;
  }
  if (typeof window.remaining === 'number' && Number.isFinite(window.remaining)) {
    result.remaining = window.remaining;
  }
  if (typeof window.resetAt === 'string' && window.resetAt.trim()) {
    result.resetAt = window.resetAt.trim();
  }
  if (typeof window.message === 'string' && window.message.trim()) {
    result.message = window.message.trim();
  }
  return result;
}

/**
 * Normalise the legacy `usedPercent / resetAfterSeconds` window shape
 * (as described by the task contract) into the standard
 * OauthAccountQuotaWindow shape that resolveQuotaWindowPercent /
 * resolveQuotaWindowSummary understand.
 */
function normalizeQuotaWindowLegacy(window: any): OauthAccountQuotaWindow | null {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return null;
  const usedPercent =
    typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
      ? window.usedPercent
      : undefined;
  const resetAfterSeconds =
    typeof window.resetAfterSeconds === 'number' && Number.isFinite(window.resetAfterSeconds)
      ? window.resetAfterSeconds
      : undefined;
  if (usedPercent === undefined && resetAfterSeconds === undefined) return null;

  const result: OauthAccountQuotaWindow = { supported: true };
  if (usedPercent !== undefined) {
    const percent = Math.max(0, Math.min(100, Math.round(usedPercent)));
    result.used = percent;
    result.limit = 100;
    result.remaining = Math.max(0, 100 - percent);
  }
  if (resetAfterSeconds !== undefined && resetAfterSeconds > 0) {
    result.resetAt = new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
  }
  return result;
}

function normalizeOauthQuotaWindowPair(
  quota: any,
): { fiveHour: OauthAccountQuotaWindow | null; sevenDay: OauthAccountQuotaWindow | null } | null {
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return null;

  // Server OauthQuotaSnapshot shape: quota.windows.fiveHour / quota.windows.sevenDay
  if (quota.windows && typeof quota.windows === 'object' && !Array.isArray(quota.windows)) {
    const fiveHour = normalizeQuotaWindowState(quota.windows.fiveHour);
    const sevenDay = normalizeQuotaWindowState(quota.windows.sevenDay);
    if (!fiveHour && !sevenDay) return null;
    return { fiveHour, sevenDay };
  }

  // Legacy / task-described shape: quota.fiveHour / quota.sevenDay (usedPercent / resetAfterSeconds)
  const fiveHour = normalizeQuotaWindowLegacy(quota.fiveHour);
  const sevenDay = normalizeQuotaWindowLegacy(quota.sevenDay);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

/**
 * Parse OAuth account info from an account row.
 *
 * Returns a structured OauthAccountInfo when the account is managed by an
 * OAuth provider (detected via the oauthProvider column or extraConfig.oauth.provider).
 * Returns null for non-OAuth accounts so callers can conditionally render.
 *
 * Quota windows are normalised into the same shape that
 * resolveQuotaWindowPercent / resolveQuotaWindowSummary from
 * connectionPresentation.tsx understand (supported / used / limit / remaining / resetAt).
 *
 * No extra API requests are made — all data comes from the account row itself.
 */
export function parseOauthAccountInfo(account: any): OauthAccountInfo | null {
  if (!account) return null;

  const extraConfig = parseAccountExtraConfigJson(account);
  const oauth = extraConfig?.oauth;
  if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return null;

  // Provider: prefer the dedicated oauthProvider column (set by server),
  // fall back to extraConfig.oauth.provider (legacy / in-flight writes).
  const provider =
    asTrimmedString(account?.oauthProvider) || asTrimmedString(oauth.provider);
  if (!provider) return null;

  const email = asTrimmedString(oauth.email);
  const planType = asTrimmedString(oauth.planType);
  const quota = normalizeOauthQuotaWindowPair(oauth.quota);

  return { provider, email, planType, quota };
}

// ── Sub2API subscription usage helpers ─────────────────────────────────────
// 参考 sites.ts aggregateSiteSubscription 的聚合语义，在账号行内展示订阅用量
// （套餐 / 已用 / 总额度 / 剩余），让 sub2api 账号在账户管理页也能看到用量，
// 而不是只有裸余额。

export type Sub2ApiAccountUsage = {
  planNames: string[];
  totalUsedUsd: number;
  totalMonthlyLimitUsd: number | null;
  totalRemainingUsd: number | null;
  nextExpiresAt: string | null;
  activeCount: number;
};

function asNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function asIsoDateString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function pickEarlierIsoDate(a?: string | null, b?: string | null): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isNaN(aMs)) return b;
  if (Number.isNaN(bMs)) return a;
  return aMs <= bMs ? a : b;
}

/**
 * 解析账号 extraConfig.sub2apiSubscription，聚合出账号级订阅用量。
 * 返回 null 表示该账号没有可用订阅数据（非 sub2api 或数据为空）。
 */
export function parseSub2ApiAccountUsage(account: any): Sub2ApiAccountUsage | null {
  if (!account) return null;
  const extraConfig = parseAccountExtraConfigJson(account);
  const raw = extraConfig?.sub2apiSubscription;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const rawRecord = raw as Record<string, unknown>;
  const subscriptions = Array.isArray(rawRecord.subscriptions)
    ? rawRecord.subscriptions.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];

  const planNames = new Set<string>();
  let totalMonthlyLimitUsd: number | null = null;
  let nextExpiresAt: string | null = null;

  for (const item of subscriptions) {
    const groupName = asTrimmedString(item.groupName ?? item.group_name);
    if (groupName) planNames.add(groupName);
    const monthlyLimitUsd = asNonNegativeNumber(item.monthlyLimitUsd ?? item.monthly_limit_usd);
    if (monthlyLimitUsd !== undefined) {
      totalMonthlyLimitUsd = (totalMonthlyLimitUsd ?? 0) + monthlyLimitUsd;
    }
    const expiresAt = asIsoDateString(item.expiresAt ?? item.expires_at ?? item.endAt ?? item.end_at);
    if (expiresAt) {
      nextExpiresAt = pickEarlierIsoDate(nextExpiresAt, expiresAt);
    }
  }

  const activeCount = asNonNegativeNumber(rawRecord.activeCount ?? rawRecord.active_count);
  const totalUsedUsd = asNonNegativeNumber(rawRecord.totalUsedUsd ?? rawRecord.total_used_usd);
  if (activeCount === undefined && totalUsedUsd === undefined && planNames.size === 0 && totalMonthlyLimitUsd === null) {
    return null;
  }

  const usedValue = totalUsedUsd ?? 0;
  const remaining = totalMonthlyLimitUsd == null
    ? null
    : Math.max(0, Math.round((totalMonthlyLimitUsd - usedValue) * 1_000_000) / 1_000_000);

  return {
    planNames: Array.from(planNames),
    totalUsedUsd: usedValue,
    totalMonthlyLimitUsd,
    totalRemainingUsd: remaining,
    nextExpiresAt,
    activeCount: Math.trunc(activeCount ?? subscriptions.length),
  };
}

export function formatSub2ApiUsageInline(usage: Sub2ApiAccountUsage | null): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.planNames.length > 0) parts.push(usage.planNames.join('/'));
  if (usage.totalRemainingUsd != null) parts.push(`剩余$${usage.totalRemainingUsd.toFixed(2)}`);
  parts.push(`已用$${usage.totalUsedUsd.toFixed(2)}`);
  if (usage.totalMonthlyLimitUsd != null) parts.push(`总额度$${usage.totalMonthlyLimitUsd.toFixed(2)}`);
  if (usage.nextExpiresAt) {
    const deltaMs = Date.parse(usage.nextExpiresAt) - Date.now();
    if (Number.isFinite(deltaMs) && deltaMs > 0) {
      const dayMs = 24 * 60 * 60 * 1000;
      if (deltaMs >= dayMs) parts.push(`剩余${Math.ceil(deltaMs / dayMs)}天`);
      else if (deltaMs >= 60 * 60 * 1000) parts.push(`剩余${Math.ceil(deltaMs / (60 * 60 * 1000))}小时`);
      else if (deltaMs >= 60 * 1000) parts.push(`剩余${Math.ceil(deltaMs / (60 * 1000))}分钟`);
    } else if (Number.isFinite(deltaMs)) {
      parts.push('已到期');
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
