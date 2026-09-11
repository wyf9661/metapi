import {
  BasePlatformAdapter,
  type BalanceInfo,
  type CheckinResult,
  type TokenVerifyResult,
  type UserInfo,
} from './base.js';
import { normalizePlatformBaseUrl, resolveVersionedModelsUrl } from './standardApiProvider.js';

/**
 * MetAPI peer-site adapter.
 *
 * A "metapi" site is another MetAPI instance used as an upstream. Credential
 * handling mirrors the new-api dual-track model:
 *
 * - Admin token  → tokenType 'session': true cascade. The peer overview
 *   endpoint exposes the same site-level numbers the peer's own dashboard
 *   shows (total balance across active accounts, today's spend, today's
 *   checkin reward), refreshed by the regular hourly balance pipeline.
 * - Downstream `sk-` key → tokenType 'apikey': plain proxy channel. No panel
 *   data exists for it and none is exposed.
 *
 * Probing: /api/v1/peer/overview answers 401 without any MetAPI-specific
 * marker for every non-admin credential, so an unauthorized holder cannot
 * even tell the peer surface exists. The platform is only identifiable by
 * presenting a valid admin token (or the site title, used as a hint only).
 */

const PEER_PROTOCOL_VERSION = 1;

type PeerOverviewPayload = {
  protocolVersion?: number;
  site?: {
    totalBalance?: number | null;
    totalUsed?: number | null;
    activeAccounts?: number | null;
    totalAccounts?: number | null;
  };
  today?: {
    spend?: number | null;
    reward?: number | null;
  };
  updatedAt?: string | null;
};

function normalizePeerBaseUrl(baseUrl: string): string {
  return normalizePlatformBaseUrl(baseUrl).replace(/\/v1$/i, '');
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function fetchPeerOverview(baseUrl: string, token: string): Promise<PeerOverviewPayload | null> {
  const target = `${normalizePeerBaseUrl(baseUrl)}/api/v1/peer/overview`;
  const { fetch } = await import('undici');
  const res = await fetch(target, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const payload = (await res.json()) as PeerOverviewPayload;
  if (payload?.protocolVersion !== PEER_PROTOCOL_VERSION) return null;
  return payload;
}

export class MetApiAdapter extends BasePlatformAdapter {
  readonly platformName = 'metapi';

  async detect(url: string): Promise<boolean> {
    // No-credential probe must stay featureless: the overview endpoint answers
    // a bare 401 like any other admin API. Auto-detection therefore relies on
    // the site title hint ("Metapi") + alias table, not on an unauthenticated
    // fingerprint. detect() here only claims URLs that literally point at a
    // metapi hostname, mirroring the openai adapter's api.openai.com check.
    const normalized = (url || '').toLowerCase();
    return /(^|\/\/|\.)(metapi|met-api)\.[a-z0-9.-]+\//.test(normalized)
      || normalized.includes('metapi.');
  }

  override async login(_baseUrl: string, _username: string, _password: string) {
    return {
      success: false as const,
      message: 'metapi peer sites authenticate with the admin token or a downstream key',
    };
  }

  override async getUserInfo(_baseUrl: string, _accessToken: string): Promise<UserInfo | null> {
    return null;
  }

  async checkin(_baseUrl: string, _accessToken: string): Promise<CheckinResult> {
    return { success: false, message: 'metapi peer sites do not support checkin' };
  }

  override async verifyToken(baseUrl: string, token: string): Promise<TokenVerifyResult> {
    // Track 1: admin token → true cascade with site-level metrics.
    const overview = await fetchPeerOverview(baseUrl, token).catch(() => null);
    if (overview) {
      const balance = this.mapOverviewToBalance(overview);
      const models = await this.getModels(baseUrl, token).catch(() => [] as string[]);
      return { tokenType: 'session', balance, models };
    }

    // Track 2: downstream key → plain proxy channel.
    const models = await this.getModels(baseUrl, token).catch(() => [] as string[]);
    if (models.length > 0) {
      return { tokenType: 'apikey', models };
    }

    return { tokenType: 'unknown' };
  }

  override async getApiToken(baseUrl: string, accessToken: string): Promise<string | null> {
    // Admin-token cascade: pull the peer's shared cascade downstream key so
    // proxying runs on an sk- key instead of the admin token. The peer's
    // /api/v1/peer/cascade-key is reuse-first and idempotent, mirroring the
    // new-api token-list flow this feeds into.
    const target = `${normalizePeerBaseUrl(baseUrl)}/api/v1/peer/cascade-key`;
    try {
      const { fetch } = await import('undici');
      const res = await fetch(target, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const payload = (await res.json()) as { key?: unknown };
      return typeof payload?.key === 'string' && payload.key.trim() ? payload.key.trim() : null;
    } catch {
      return null;
    }
  }

  override async deleteApiToken(
    _baseUrl: string,
    _accessToken: string,
    _tokenKey: string,
    _platformUserId?: number,
  ): Promise<boolean> {
    // The cascade key is shared by every cascading peer on the upstream, so a
    // local delete must never revoke it upstream — peers would lose their
    // shared credential. Deleting the local row is enough; actual revocation
    // happens on the peer's own dashboard.
    return true;
  }

  private mapOverviewToBalance(overview: PeerOverviewPayload): BalanceInfo {
    const site = overview.site || {};
    const today = overview.today || {};
    const totalBalance = toFiniteNumber(site.totalBalance);
    const totalUsed = toFiniteNumber(site.totalUsed);
    // BalanceInfo mapping, new-api-style semantics:
    // - balance = remaining spendable pool (the peer's real total balance)
    // - used    = lifetime spend recorded by the peer
    // - quota   = 0: MetAPI has no single pool cap concept
    // - todayQuotaConsumption / todayIncome = today's spend / reward, feeding
    //   the same UI slots the new-api sites use.
    return {
      balance: totalBalance ?? 0,
      used: totalUsed ?? 0,
      quota: 0,
      todayQuotaConsumption: toFiniteNumber(today.spend) ?? 0,
      todayIncome: toFiniteNumber(today.reward) ?? 0,
    };
  }

  override async getBalance(baseUrl: string, accessToken: string): Promise<BalanceInfo> {
    const overview = await fetchPeerOverview(baseUrl, accessToken);
    if (!overview) {
      throw new Error('peer overview unavailable (admin token required)');
    }
    return this.mapOverviewToBalance(overview);
  }

  async getModels(baseUrl: string, apiToken: string): Promise<string[]> {
    const url = resolveVersionedModelsUrl(normalizePeerBaseUrl(baseUrl));
    try {
      const { fetch } = await import('undici');
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (!res.ok) return [];
      const payload = (await res.json()) as { data?: Array<{ id?: unknown }> };
      if (!Array.isArray(payload?.data)) return [];
      return payload.data
        .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
        .filter((item) => item.length > 0);
    } catch {
      // Same contract as StandardApiProviderAdapterBase: transport failures
      // yield an empty catalog ("unknown") instead of aborting discovery.
      return [];
    }
  }
}
