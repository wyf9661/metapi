import { schema } from '../../db/index.js';
import type { OauthQuotaSnapshot } from './quotaTypes.js';

type ParsedOauthInfo = {
  provider?: unknown;
  accountId?: unknown;
  accountKey?: unknown;
  email?: unknown;
  planType?: unknown;
  projectId?: unknown;
  tokenExpiresAt?: unknown;
  refreshToken?: unknown;
  idToken?: unknown;
  providerData?: unknown;
  quota?: unknown;
  modelDiscoveryStatus?: unknown;
  lastModelSyncAt?: unknown;
  lastModelSyncError?: unknown;
  lastDiscoveredModels?: unknown;
};

type ParsedExtraConfig = {
  oauth?: ParsedOauthInfo;
};

export type OauthModelDiscoveryStatus = 'healthy' | 'abnormal';

export type OauthInfo = {
  provider: string;
  accountId?: string;
  accountKey?: string;
  email?: string;
  planType?: string;
  projectId?: string;
  tokenExpiresAt?: number;
  refreshToken?: string;
  idToken?: string;
  providerData?: Record<string, unknown>;
  quota?: OauthQuotaSnapshot;
  modelDiscoveryStatus?: OauthModelDiscoveryStatus;
  lastModelSyncAt?: string;
  lastModelSyncError?: string;
  lastDiscoveredModels?: string[];
};

export type StoredOauthState = Omit<OauthInfo, 'provider' | 'accountId' | 'accountKey' | 'projectId'>;

type OauthIdentityCarrier = {
  extraConfig?: string | null;
  oauthProvider?: string | null;
  oauthAccountKey?: string | null;
  oauthProjectId?: string | null;
};

function parseExtraConfig(extraConfig?: string | null): ParsedExtraConfig {
  if (!extraConfig) return {};
  try {
    const parsed = JSON.parse(extraConfig) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as ParsedExtraConfig;
  } catch {
    return {};
  }
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function asIsoDateTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => asTrimmedString(item))
    .filter((item): item is string => !!item);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asQuotaSnapshot(value: unknown): OauthQuotaSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as OauthQuotaSnapshot;
}

function asModelDiscoveryStatus(value: unknown): OauthModelDiscoveryStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'healthy') return 'healthy';
  if (normalized === 'abnormal') return 'abnormal';
  return undefined;
}

function parseStoredOauthState(extraConfig?: string | null): Partial<OauthInfo> | null {
  const parsed = parseExtraConfig(extraConfig).oauth;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const accountKey = asTrimmedString(parsed.accountKey) || asTrimmedString(parsed.accountId);
  return {
    provider: asTrimmedString(parsed.provider),
    accountId: asTrimmedString(parsed.accountId) || accountKey,
    accountKey,
    email: asTrimmedString(parsed.email),
    planType: asTrimmedString(parsed.planType),
    projectId: asTrimmedString(parsed.projectId),
    tokenExpiresAt: asPositiveInteger(parsed.tokenExpiresAt),
    refreshToken: asTrimmedString(parsed.refreshToken),
    idToken: asTrimmedString(parsed.idToken),
    providerData: asRecord(parsed.providerData),
    quota: asQuotaSnapshot(parsed.quota),
    modelDiscoveryStatus: asModelDiscoveryStatus(parsed.modelDiscoveryStatus),
    lastModelSyncAt: asIsoDateTime(parsed.lastModelSyncAt),
    lastModelSyncError: asTrimmedString(parsed.lastModelSyncError),
    lastDiscoveredModels: asStringArray(parsed.lastDiscoveredModels),
  };
}

export function getOauthInfoFromExtraConfig(extraConfig?: string | null): OauthInfo | null {
  const parsed = parseStoredOauthState(extraConfig);
  const provider = parsed?.provider;
  if (!provider) return null;
  return {
    provider,
    accountId: parsed.accountId || parsed.accountKey,
    accountKey: parsed.accountKey,
    email: parsed.email,
    planType: parsed.planType,
    projectId: parsed.projectId,
    tokenExpiresAt: parsed.tokenExpiresAt,
    refreshToken: parsed.refreshToken,
    idToken: parsed.idToken,
    providerData: parsed.providerData,
    quota: parsed.quota,
    modelDiscoveryStatus: parsed.modelDiscoveryStatus,
    lastModelSyncAt: parsed.lastModelSyncAt,
    lastModelSyncError: parsed.lastModelSyncError,
    lastDiscoveredModels: parsed.lastDiscoveredModels,
  };
}

export function getOauthInfoFromAccount(account?: OauthIdentityCarrier | null): OauthInfo | null {
  if (!account) return null;
  const stored = parseStoredOauthState(account.extraConfig);
  const provider = asTrimmedString(account.oauthProvider) || stored?.provider;
  if (!provider) return null;
  const structuredAccountKey = asTrimmedString(account.oauthAccountKey);
  const accountKey = structuredAccountKey || stored?.accountKey || stored?.accountId;
  const projectId = asTrimmedString(account.oauthProjectId) || stored?.projectId;
  return {
    ...(stored || {}),
    provider,
    accountId: structuredAccountKey || stored?.accountId || accountKey,
    accountKey,
    projectId,
  };
}

export function buildOauthInfo(
  extraConfig?: string | null,
  patch: Partial<OauthInfo> = {},
): OauthInfo {
  const provider = patch.provider || getOauthInfoFromExtraConfig(extraConfig)?.provider;
  if (!provider) {
    throw new Error('oauth provider is required');
  }
  const current = getOauthInfoFromExtraConfig(extraConfig);
  const next: OauthInfo = {
    provider,
    ...(current || {}),
    ...patch,
  };
  if (!next.accountKey && next.accountId) {
    next.accountKey = next.accountId;
  }
  if (!next.accountId && next.accountKey) {
    next.accountId = next.accountKey;
  }
  return next;
}

export function buildOauthInfoFromAccount(
  account?: OauthIdentityCarrier | null,
  patch: Partial<OauthInfo> = {},
): OauthInfo {
  const provider = patch.provider || getOauthInfoFromAccount(account)?.provider;
  if (!provider) {
    throw new Error('oauth provider is required');
  }
  const current = getOauthInfoFromAccount(account);
  const next: OauthInfo = {
    provider,
    ...(current || {}),
    ...patch,
  };
  if (!next.accountKey && next.accountId) {
    next.accountKey = next.accountId;
  }
  if (!next.accountId && next.accountKey) {
    next.accountId = next.accountKey;
  }
  return next;
}

export function buildStoredOauthState(oauth: OauthInfo): StoredOauthState {
  const {
    provider: _provider,
    accountId: _accountId,
    accountKey: _accountKey,
    projectId: _projectId,
    ...stored
  } = oauth;
  return stored;
}

export function buildStoredOauthStateFromAccount(
  account?: OauthIdentityCarrier | null,
  patch: Partial<OauthInfo> = {},
): StoredOauthState {
  return buildStoredOauthState(buildOauthInfoFromAccount(account, patch));
}

export function isOauthProvider(
  account: Pick<typeof schema.accounts.$inferSelect, 'extraConfig'> | string | null | undefined,
  provider?: string,
): boolean {
  const extraConfig = typeof account === 'string' || account == null
    ? account
    : account.extraConfig;
  const oauth = getOauthInfoFromExtraConfig(extraConfig);
  if (!oauth) return false;
  if (!provider) return true;
  return oauth.provider === provider;
}
