import { ApiTokenInfo, BasePlatformAdapter, CheckinResult, BalanceInfo, UserInfo, TokenVerifyResult, CreateApiTokenOptions, type DeleteApiTokenResult, type ModelDiscoveryOptions, type SiteAnnouncement } from './base.js';
import type { RequestInit as UndiciRequestInit } from 'undici';
import {
  describeUnusableVariantResponse,
  describeVariantError,
  logAllVariantsFailed,
  type PlatformVariantFailure,
} from './platformVariantFailures.js';
import { fetchJsonWithShieldCookieRetry, classifyShieldGateFailureText, NewApiShieldError } from './newApiShield.js';
import { CODEX_CLI_USER_AGENT } from '../../shared/codexClientFamily.js';
import { locateTokenInKeys } from '../../shared/tokenMask.js';

// Codex CLI client fingerprint for model discovery calls on sites whose
// protocol profile requires a Codex client ("Codex 兼容" site setting). Chat
// traffic gets the full version-consistent fingerprint from
// upstreamRequestBuilder; discovery bypasses that builder, so /v1/models
// presents the minimal fingerprint here. The UA comes from the shared Codex
// client identity so discovery can never drift from the proxy surfaces.
const CODEX_DISCOVERY_FINGERPRINT_HEADERS: Record<string, string> = {
  'user-agent': CODEX_CLI_USER_AGENT,
  originator: 'codex_cli_rs',
};

export class NewApiAdapter extends BasePlatformAdapter {
  readonly platformName: string = 'new-api';

  protected override async fetchJson<T>(url: string, options?: UndiciRequestInit): Promise<T> {
    const result = await fetchJsonWithShieldCookieRetry<T>(url, options);
    if (result.failure) throw new NewApiShieldError(result.failure);
    if (!result.ok) throw new Error(`HTTP ${result.status}: 上游请求未完成`);
    return result.data as T;
  }

  async detect(url: string): Promise<boolean> {
    try {
      const res = await this.fetchJson<any>(`${url}/api/status`);
      return res?.success === true && typeof res?.data?.system_name === 'string';
    } catch {
      return false;
    }
  }

  override async getSiteAnnouncements(baseUrl: string, _accessToken: string): Promise<SiteAnnouncement[]> {
    try {
      const payload = await this.fetchJson<any>(`${baseUrl}/api/notice`);
      const content = typeof payload?.data === 'string'
        ? payload.data.trim()
        : (typeof payload === 'string' ? payload.trim() : '');
      if (!content) return [];
      return [{
        sourceKey: this.buildNoticeSourceKey(content),
        // Chinese is the source language; the web UI translates titles for
        // English mode (i18n: 站点通知 -> Site Notice).
        title: '站点通知',
        content,
        level: 'info',
        sourceUrl: '/api/notice',
        rawPayload: payload,
      }];
    } catch {
      return [];
    }
  }

  private tryDecodeUserId(token: string): number | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (typeof payload?.id === 'number') return payload.id;
      if (typeof payload?.sub === 'string' || typeof payload?.sub === 'number') {
        const n = Number.parseInt(String(payload.sub), 10);
        if (!Number.isNaN(n)) return n;
      }
    } catch {}
    return null;
  }

  private authHeaders(accessToken: string, userId?: number): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      ...this.userIdHeaders(userId),
    };
  }

  private userIdHeaders(userId?: number | null): Record<string, string> {
    const headers: Record<string, string> = {};
    if (userId) {
      const value = String(userId);
      headers['New-API-User'] = value;

      headers['voapi-user'] = value;
      headers['User-id'] = value;
      headers['X-User-Id'] = value;
      headers['Rix-Api-User'] = value;
      headers['neo-api-user'] = value;
    }
    return headers;
  }

  private buildCookieCandidates(token: string): string[] {
    const trimmed = (token || '').trim();
    if (!trimmed) return [];

    const raw = trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
    const candidates: string[] = [];

    // Only treat as a full Cookie header when it looks like name=value pairs.
    if (this.looksLikeCookiePairCredential(raw)) {
      candidates.push(raw);
    }

    candidates.push(`session=${raw}`);
    candidates.push(`token=${raw}`);

    return Array.from(new Set(candidates));
  }


  private decodeBase64BufferLoose(value: string): Buffer | null {
    if (!value) return null;
    try {
      return Buffer.from(value, 'base64');
    } catch {}
    try {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      return Buffer.from(normalized, 'base64');
    } catch {}
    return null;
  }

  private decodeGobSignedInt(encoded: Buffer): number | null {
    if (!encoded.length) return null;

    let unsigned = 0n;
    if (encoded[0] < 0x80) {
      unsigned = BigInt(encoded[0]);
    } else {
      const width = 0x100 - encoded[0];
      if (width <= 0 || encoded.length !== width + 1) return null;
      for (let i = 1; i < encoded.length; i += 1) {
        unsigned = (unsigned << 8n) | BigInt(encoded[i]);
      }
    }

    const signed = (unsigned & 1n) === 0n
      ? unsigned >> 1n
      : -((unsigned >> 1n) + 1n);
    if (signed <= 0n || signed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(signed);
  }

  private extractGobFieldInts(payload: Buffer, fieldName: string): number[] {
    const ids: number[] = [];
    const push = (value: number | null) => {
      if (typeof value !== 'number' || Number.isNaN(value)) return;
      if (value <= 0 || value > 10_000_000) return;
      if (!ids.includes(value)) ids.push(value);
    };

    const marker = Buffer.concat([
      Buffer.from(fieldName, 'utf8'),
      Buffer.from([0x03]),
      Buffer.from('int', 'utf8'),
      Buffer.from([0x04]),
    ]);

    let start = 0;
    while (start < payload.length) {
      const position = payload.indexOf(marker, start);
      if (position < 0) break;

      const encodedLength = payload[position + marker.length];
      const delimiter = payload[position + marker.length + 1];
      if (typeof encodedLength === 'number' && delimiter === 0x00) {
        const byteLength = encodedLength - 1;
        const valueStart = position + marker.length + 2;
        const valueEnd = valueStart + byteLength;
        if (byteLength > 0 && valueEnd <= payload.length) {
          push(this.decodeGobSignedInt(payload.subarray(valueStart, valueEnd)));
        }
      }

      start = position + marker.length;
    }

    return ids;
  }

  private extractLikelyUserIds(token: string): number[] {
    const ids: number[] = [];
    const push = (value: unknown) => {
      const n = Number.parseInt(String(value), 10);
      if (Number.isNaN(n)) return;
      if (n <= 0 || n > 10_000_000) return;
      if (!ids.includes(n)) ids.push(n);
    };

    const raw = (token || '').trim();
    if (!raw) return ids;

    const cookieCandidates = this.buildCookieCandidates(raw);
    const sessionValues = new Set<string>();
    for (const candidate of cookieCandidates) {
      const match = candidate.match(/(?:^|;\s*)session=([^;]+)/i);
      if (match?.[1]) sessionValues.add(match[1].trim());
    }

    if (raw && !raw.includes('=')) {
      sessionValues.add(raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw);
    }

    for (const sessionValue of sessionValues) {
      const decodedBuffer = this.decodeBase64BufferLoose(sessionValue);
      if (!decodedBuffer) continue;

      const decoded = decodedBuffer.toString('utf8');

      const payloadCandidates: string[] = [decoded];
      const payloadBuffers: Buffer[] = [decodedBuffer];
      const parts = decoded.split('|');
      if (parts.length >= 2) {
        const middlePayloadBuffer = this.decodeBase64BufferLoose(parts[1]);
        if (middlePayloadBuffer) {
          payloadCandidates.push(middlePayloadBuffer.toString('utf8'));
          payloadBuffers.push(middlePayloadBuffer);
        }
      }

      for (const payload of payloadCandidates) {
        for (const m of payload.matchAll(/_(\d{4,8})(?!\d)/g)) {
          push(m[1]);
        }
        for (const m of payload.matchAll(/(?:user(?:name)?|uid|id)[^\d]{0,16}(\d{4,8})(?!\d)/gi)) {
          push(m[1]);
        }
      }

      for (const payload of payloadBuffers) {
        for (const value of this.extractGobFieldInts(payload, 'id')) {
          push(value);
        }
      }
    }

    return ids;
  }

  private buildUserIdProbeCandidates(token: string): number[] {
    const candidates: number[] = [];
    const push = (value: number | null) => {
      if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return;
      if (!candidates.includes(value)) candidates.push(value);
    };

    push(this.tryDecodeUserId(token));
    for (const guessed of this.extractLikelyUserIds(token)) {
      push(guessed);
    }
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 50, 100, 8899, 11494]) {
      push(id);
    }

    return candidates;
  }

  private parseTokenItems(payload: any): any[] {
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.data?.items)) return payload.data.items;
    if (Array.isArray(payload?.data?.data)) return payload.data.data;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.list)) return payload.list;
    if (Array.isArray(payload?.data?.list)) return payload.data.list;
    return [];
  }

  private isTokenListResponse(payload: any): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (payload?.success === true) return true;
    return (
      Array.isArray(payload?.data)
      || Array.isArray(payload?.data?.items)
      || Array.isArray(payload?.data?.data)
      || Array.isArray(payload?.items)
      || Array.isArray(payload?.list)
      || Array.isArray(payload?.data?.list)
    );
  }

  private normalizeTokenKeyForCompare(value?: string | null): string {
    const trimmed = (value || '').trim();
    return trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
  }

  private parseGroupKeys(payload: any): string[] {
    if (payload && typeof payload === 'object' && payload?.success === false) {
      return [];
    }

    const source = payload?.data ?? payload;
    if (Array.isArray(source)) {
      return source
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    }

    if (source && typeof source === 'object') {
      return Object.keys(source)
        .map((key) => key.trim())
        .filter((key) => !['success', 'message', 'code', 'data', 'error'].includes(key.toLowerCase()))
        .filter(Boolean);
    }

    return [];
  }

  private resolveGroupFetchErrorMessage(payload: any): string {
    const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
    const normalized = message.toLowerCase();
    const indicatesExpired = normalized.includes('expired')
      || normalized.includes('invalid token')
      || normalized.includes('access token')
      || normalized.includes('unauthorized')
      || normalized.includes('forbidden')
      || normalized.includes('未登录')
      || normalized.includes('登录')
      || normalized.includes('过期');
    if (indicatesExpired) return '账号会话可能已过期，请重新登录后再拉取分组';
    return message || '拉取分组失败';
  }

  private normalizeTokenItems(items: any[]): ApiTokenInfo[] {
    const normalized: ApiTokenInfo[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const key = typeof item?.key === 'string' ? item.key.trim() : '';
      if (!key) continue;
      const rawName = typeof item?.name === 'string' ? item.name.trim() : '';
      const rawGroup = typeof item?.group === 'string'
        ? item.group.trim()
        : (typeof item?.group_name === 'string'
          ? item.group_name.trim()
          : (typeof item?.token_group === 'string' ? item.token_group.trim() : ''));
      const status = typeof item?.status === 'number' ? item.status : undefined;
      const tokenInfo: ApiTokenInfo = {
        name: rawName || (index === 0 ? 'default' : `token-${index + 1}`),
        key,
        enabled: status === undefined ? true : status === 1,
      };
      if (rawGroup) tokenInfo.tokenGroup = rawGroup;
      normalized.push(tokenInfo);
    }
    return normalized;
  }

  private parseUserInfo(data: any): UserInfo {
    return {
      username: data?.username || data?.display_name || '',
      displayName: data?.display_name,
      email: data?.email,
      role: data?.role,
    };
  }

  private parseBalance(data: any): BalanceInfo {
    const quota = (data?.quota || 0) / 500000;
    const used = (data?.used_quota || 0) / 500000;
    const total = quota + used;
    const todayIncome = Number.isFinite(data?.today_income) ? (data.today_income / 500000) : undefined;
    const todayQuotaConsumption = Number.isFinite(data?.today_quota_consumption) ? (data.today_quota_consumption / 500000) : undefined;
    return { balance: quota, used, quota: total, todayIncome, todayQuotaConsumption };
  }

  private extractLoginAccessToken(payload: any): string | null {
    const candidates: unknown[] = [
      payload?.data,
      payload?.token,
      payload?.accessToken,
      payload?.access_token,
      payload?.data?.token,
      payload?.data?.accessToken,
      payload?.data?.access_token,
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const token = candidate.trim();
      if (token) return token;
    }
    return null;
  }

  private buildDefaultTokenPayload(options?: CreateApiTokenOptions): Record<string, unknown> {
    const normalizedName = (options?.name || '').trim() || 'metapi';
    const unlimitedQuota = options?.unlimitedQuota ?? true;
    const remainQuota = Number.isFinite(options?.remainQuota)
      ? Math.max(0, Math.trunc(options?.remainQuota as number))
      : 0;
    const expiredTime = Number.isFinite(options?.expiredTime)
      ? Math.trunc(options?.expiredTime as number)
      : -1;
    return {
      name: normalizedName,
      unlimited_quota: unlimitedQuota,
      expired_time: expiredTime,
      remain_quota: remainQuota,
      allow_ips: (options?.allowIps || '').trim(),
      model_limits_enabled: options?.modelLimitsEnabled ?? false,
      model_limits: (options?.modelLimits || '').trim(),
      group: (options?.group || '').trim(),
    };
  }

  private parseJsonSafe<T>(text: string): T | null {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private extractHtmlErrorSummary(payloadRaw: string): string | null {
    const text = (payloadRaw || '').trim();
    if (!text || !/<html|<!doctype/i.test(text)) return null;

    const titleMatch = text.match(/<title>\s*([^<]+?)\s*<\/title>/i);
    let title = titleMatch?.[1]?.trim() || '';
    if (title.includes('|')) {
      title = title.split('|')[0]?.trim() || title;
    }
    if (!title && /cloudflare tunnel error/i.test(text)) {
      title = 'Cloudflare Tunnel error';
    }
    if (!title) return null;

    const codeMatch = text.match(/<span[^>]*>\s*Error\s*<\/span>\s*<span[^>]*>\s*(\d{3,4})\s*<\/span>/i)
      || text.match(/\bError\s*(\d{3,4})\b/i);
    const code = codeMatch?.[1];
    return code ? `${title} (Error ${code})` : title;
  }

  private formatRequestErrorMessage(err: unknown): string | null {
    const raw = typeof (err as { message?: unknown })?.message === 'string'
      ? (err as { message: string }).message.trim()
      : '';
    if (!raw) return null;

    const httpMatch = raw.match(/^(HTTP\s+\d+):\s*([\s\S]+)$/);
    if (!httpMatch) return raw;

    const [, prefix, payloadRaw] = httpMatch;
    const payload = this.parseJsonSafe<any>(payloadRaw);
    const bodyMessage = this.extractResponseMessage(payload);
    if (bodyMessage) return `${prefix}: ${bodyMessage}`;
    const htmlSummary = this.extractHtmlErrorSummary(payloadRaw);
    if (htmlSummary) return `${prefix}: ${htmlSummary}`;
    return raw;
  }

  private extractResponseMessage(payload: any): string {
    if (typeof payload?.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
    if (typeof payload?.error?.message === 'string' && payload.error.message.trim()) {
      return payload.error.message.trim();
    }
    if (typeof payload?.msg === 'string' && payload.msg.trim()) {
      return payload.msg.trim();
    }
    return '';
  }

  private isHtmlJsonParseErrorMessage(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    return (
      text.includes("unexpected token '<'")
      || (text.includes('not valid json') && (text.includes('<html') || text.includes('<script')))
    );
  }

  private hasUsableSessionCookie(cookieHeader: string): boolean {
    if (!cookieHeader) return false;
    const ignored = new Set(['acw_tc', 'acw_sc__v2', 'cdn_sec_tc']);
    const pairs = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean);
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim().toLowerCase();
      if (!name || ignored.has(name)) continue;
      if (
        name === 'session'
        || name === 'token'
        || name === 'auth_token'
        || name === 'access_token'
        || name === 'jwt'
        || name === 'jwt_token'
        || name.includes('session')
        || name.includes('token')
        || name.includes('auth')
      ) {
        return true;
      }
    }
    return false;
  }


  private isAlreadyCheckedInMessage(message?: string | null): boolean {
    if (!message) return false;
    const text = message.trim();
    if (!text) return false;
    const normalized = text.toLowerCase();
    return (
      normalized.includes('already checked in') ||
      normalized.includes('already signed') ||
      normalized.includes('already sign in') ||
      text.includes('今日已签到') ||
      text.includes('今天已签到') ||
      text.includes('今天已经签到') ||
      text.includes('今日已经签到') ||
      text.includes('已经签到') ||
      text.includes('已签到') ||
      text.includes('重复签到') ||
      text.includes('签到过')
    );
  }

  private looksLikeCookiePairCredential(token: string): boolean {
    const raw = (token || '').trim();
    if (!raw || !raw.includes('=')) return false;
    // Real cookie header values contain name=value pairs, often with "; " separators.
    // NewAPI session values are long base64 strings that may only end with padding "=".
    if (raw.includes(';')) {
      return /(?:^|;\s*)[A-Za-z_][A-Za-z0-9_-]*=/.test(raw);
    }
    const eq = raw.indexOf('=');
    if (eq <= 0) return false;
    const name = raw.slice(0, eq);
    // Cookie names are short identifiers. Long base64 blobs before "=" are not cookie names.
    if (name.length > 40) return false;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) return false;
    // Require a non-empty value after the first "=" (allow value padding equals).
    return raw.length > eq + 1;
  }

  private isSessionLikeCredential(token: string): boolean {
    const raw = (token || '').trim();
    if (!raw) return false;
    if (this.looksLikeCookiePairCredential(raw)) return true;
    // NewAPI session cookies are typically long base64-ish values, not sk-/eyJ tokens.
    if (raw.startsWith('sk-') || raw.startsWith('eyJ')) return false;
    return raw.length >= 80;
  }

  private rememberCheckinFailureMessage(current: string | undefined, next?: string | null): string | undefined {
    const incoming = typeof next === 'string' ? next.trim() : '';
    if (!incoming) return current;
    if (!current) return incoming;
    // Never let later auth noise override an already-checked-in result.
    if (this.isAlreadyCheckedInMessage(current)) return current;
    if (this.isAlreadyCheckedInMessage(incoming)) return incoming;
    // Prefer non-auth business errors over generic unauthorized once we have something better.
    if (this.isCookieSessionFailureMessage(current) && !this.isCookieSessionFailureMessage(incoming)) {
      return incoming;
    }
    return incoming;
  }

  private shouldFallbackToCookieCheckin(message?: string | null): boolean {
    if (!message) return true;
    if (this.isAlreadyCheckedInMessage(message)) return false;
    const text = message.toLowerCase();
    return (
      text.includes('unexpected token') ||
      text.includes('not valid json') ||
      text.includes('<html') ||
      text.includes('new-api-user') ||
      text.includes('access token') ||
      text.includes('unauthorized') ||
      text.includes('forbidden') ||
      text.includes('not login') ||
      text.includes('not logged') ||
      text.includes('invalid url (post /api/user/checkin)') ||
      (text.includes('http 404') && text.includes('/api/user/checkin')) ||
      text.includes('未登录') ||
      text.includes('未提供')
    );
  }

  private isMissingCheckinEndpointMessage(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    return (
      text.includes('invalid url (post /api/user/checkin)') ||
      (text.includes('http 404') && text.includes('/api/user/checkin')) ||
      text.includes('checkin endpoint not found') ||
      text.includes('check-in is not supported') ||
      text.includes('checkin is not supported') ||
      text.includes('does not support checkin') ||
      text.includes('not support checkin')
    );
  }

  private isCookieSessionFailureMessage(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    return (
      text.includes('access token') ||
      text.includes('unauthorized') ||
      text.includes('forbidden') ||
      text.includes('new-api-user') ||
      text.includes('user id') ||
      text.includes('invalid token') ||
      text.includes('expired') ||
      text.includes('无权') ||
      text.includes('未登录') ||
      text.includes('未提供') ||
      text.includes('未授权') ||
      text.includes('not login') ||
      text.includes('not logged')
    );
  }

  private async detectCookieSessionFailureMessage(
    baseUrl: string,
    accessToken: string,
    candidateUserIds: Array<number | null | undefined>,
  ): Promise<string | null> {
    let failureMessage: string | null = null;
    const rememberFailure = (message: string) => {
      if (failureMessage) return;
      const text = message.trim();
      if (!this.isCookieSessionFailureMessage(text)) return;
      failureMessage = text;
    };

    const uniqueCandidateUserIds = Array.from(new Set(
      candidateUserIds.filter((value): value is number => typeof value === 'number' && value > 0),
    ));

    if (uniqueCandidateUserIds.length === 0) {
      await this.fetchUserSelfByCookie(baseUrl, accessToken, undefined, rememberFailure);
      return failureMessage;
    }

    for (const userId of uniqueCandidateUserIds) {
      await this.fetchUserSelfByCookie(baseUrl, accessToken, userId, rememberFailure);
      if (failureMessage) {
        return failureMessage;
      }
    }

    return failureMessage;
  }

  private async fetchJsonRawWithCookie<T>(
    url: string,
    options?: UndiciRequestInit,
  ): Promise<{ data: T | null; cookieHeader: string }> {
    const result = await fetchJsonWithShieldCookieRetry<T>(url, options);
    if (result.failure?.terminal) throw new NewApiShieldError(result.failure);
    // Raw callers may inspect authentication errors, but never consume an
    // error status as successful token/model data.
    if (result.failure?.code === 'upstream_http_error') {
      return { ...result, data: { success: false, message: result.failure.responseMessage || '' } as T };
    }
    return result;
  }

  private async fetchJsonRaw<T>(url: string, options?: UndiciRequestInit): Promise<T | null> {
    const result = await this.fetchJsonRawWithCookie<T>(url, options);
    return result.data;
  }

  private async fetchJsonViaShield<T>(url: string, options?: UndiciRequestInit): Promise<T | null> {
    try {
      const { data } = await fetchJsonWithShieldCookieRetry<T>(url, options);
      return data;
    } catch {
      return null;
    }
  }

  private async fetchUserSelfByCookie(
    baseUrl: string,
    token: string,
    platformUserId?: number,
    onFailureMessage?: (message: string) => void,
  ): Promise<any | null> {
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of this.buildCookieCandidates(token).entries()) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        Object.assign(headers, this.userIdHeaders(platformUserId));
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, { headers });
        if (res?.success && res?.data) return res;
        if (typeof res?.message === 'string' && res.message.trim()) {
          onFailureMessage?.(res.message.trim());
        }
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeUnusableVariantResponse() });
      } catch (error) {
        if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeVariantError(error) });
      }
    }
    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('fetchUserSelfByCookie', failures);
    return null;
  }

  private async probeUserIdByCookie(baseUrl: string, token: string): Promise<number | null> {
    const candidates = this.buildUserIdProbeCandidates(token);
    const cookieCandidates = this.buildCookieCandidates(token);
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of cookieCandidates.entries()) {
      for (const id of candidates) {
        try {
          const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
            headers: { Cookie: cookie, ...this.userIdHeaders(id) },
          });
          if (res?.success && res?.data) return id;
          failures.push({ variant: `cookie#${cookieIndex + 1}/uid${id}`, reason: describeUnusableVariantResponse() });
        } catch (error) {
          if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
          failures.push({ variant: `cookie#${cookieIndex + 1}/uid${id}`, reason: describeVariantError(error) });
        }
      }
    }
    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('probeUserIdByCookie', failures);
    return null;
  }

  private async probeAlternateUserIdByCookie(
    baseUrl: string,
    token: string,
    currentUserId?: number | null,
  ): Promise<number | null> {
    const probed = await this.probeUserIdByCookie(baseUrl, token);
    if (!probed) return null;
    if (typeof currentUserId === 'number' && currentUserId > 0 && probed === currentUserId) {
      return null;
    }
    return probed;
  }

  private async getApiTokensByCookie(baseUrl: string, token: string, userId?: number | null): Promise<ApiTokenInfo[]> {
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of this.buildCookieCandidates(token).entries()) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        Object.assign(headers, this.userIdHeaders(userId));
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/token/?p=0&size=100`, { headers });
        const normalized = this.normalizeTokenItems(this.parseTokenItems(res));
        if (normalized.length > 0) return normalized;
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeUnusableVariantResponse() });
      } catch (error) {
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeVariantError(error) });
      }
    }
    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('getApiTokensByCookie', failures);
    return [];
  }

  private async getSessionModelsByCookie(baseUrl: string, token: string, userId?: number | null): Promise<string[]> {
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of this.buildCookieCandidates(token).entries()) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        Object.assign(headers, this.userIdHeaders(userId));
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/models`, { headers });
        if (Array.isArray(res?.data) && res.data.length > 0) return res.data.filter(Boolean);
        if (res?.data && typeof res.data === 'object') {
          const keys = Object.keys(res.data).filter(Boolean);
          if (keys.length > 0) return keys;
        }
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeUnusableVariantResponse() });
      } catch (error) {
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeVariantError(error) });
      }
    }
    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('getSessionModelsByCookie', failures);
    return [];
  }

  private extractOpenAiModels(payload: any): string[] {
    if (!Array.isArray(payload?.data)) return [];
    return payload.data.map((m: any) => m?.id).filter(Boolean);
  }

  private async getOpenAiModelsViaShieldCookie(baseUrl: string, token: string, options?: ModelDiscoveryOptions): Promise<string[]> {
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of this.buildCookieCandidates(token).entries()) {
      try {
        const { data } = await fetchJsonWithShieldCookieRetry<any>(`${baseUrl}/v1/models`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Cookie: cookie,
            ...(options?.requireCodexClient ? CODEX_DISCOVERY_FINGERPRINT_HEADERS : {}),
          },
        });
        const models = this.extractOpenAiModels(data);
        if (models.length > 0) return models;
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeUnusableVariantResponse() });
      } catch (error) {
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeVariantError(error) });
      }
    }
    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('getOpenAiModelsViaShieldCookie', failures);
    return [];
  }

  private async getOpenAiModels(baseUrl: string, token: string, options?: ModelDiscoveryOptions): Promise<string[]> {
    // Session base64 values often end with "=" padding; that must NOT trigger the
    const shouldTryShieldCookie = this.looksLikeCookiePairCredential(token);
    if (shouldTryShieldCookie) {
      const shieldModels = await this.getOpenAiModelsViaShieldCookie(baseUrl, token, options);
      if (shieldModels.length > 0) return shieldModels;
    }

    // API keys only: session cookies are not valid OpenAI bearer tokens.
    if (this.isSessionLikeCredential(token) && !token.trim().startsWith('sk-')) {
      return [];
    }

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/v1/models`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options?.requireCodexClient ? CODEX_DISCOVERY_FINGERPRINT_HEADERS : {}),
        },
      });
      return this.extractOpenAiModels(res);
    } catch {
      return [];
    }
  }

  private async discoverUserId
(baseUrl: string, accessToken: string): Promise<number | null> {
    const jwtId = this.tryDecodeUserId(accessToken);
    if (jwtId) {
      try {
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
          headers: this.authHeaders(accessToken, jwtId),
        });
        if (res?.success && res?.data) return jwtId;
      } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }
    }

    try {
      const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res?.success && res?.data?.id) return res.data.id;
    } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }

    try {
      const cookieRes = await this.fetchUserSelfByCookie(baseUrl, accessToken);
      if (cookieRes?.success && cookieRes?.data?.id) return cookieRes.data.id;
    } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }

    const cookieId = await this.probeUserIdByCookie(baseUrl, accessToken);
    if (cookieId) return cookieId;

    return null;
  }

  override async getUserInfo(baseUrl: string, accessToken: string, platformUserId?: number): Promise<UserInfo | null> {
    const failures: PlatformVariantFailure[] = [];
    try {
      const directRes = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (directRes?.success && directRes?.data) {
        return this.parseUserInfo(directRes.data);
      }
      failures.push({ variant: 'bearer', reason: describeUnusableVariantResponse() });
    } catch (error) {
      failures.push({ variant: 'bearer', reason: describeVariantError(error) });
    }

    try {
      const cookieRes = await this.fetchUserSelfByCookie(baseUrl, accessToken, platformUserId);
      if (cookieRes?.success && cookieRes?.data) {
        return this.parseUserInfo(cookieRes.data);
      }
      failures.push({ variant: 'cookie', reason: describeUnusableVariantResponse() });
    } catch (error) {
      failures.push({ variant: 'cookie', reason: describeVariantError(error) });
    }

    try {
      const fallbackUserId = await this.probeAlternateUserIdByCookie(baseUrl, accessToken, platformUserId);
      if (fallbackUserId) {
        const cookieRetry = await this.fetchUserSelfByCookie(baseUrl, accessToken, fallbackUserId);
        if (cookieRetry?.success && cookieRetry?.data) {
          return this.parseUserInfo(cookieRetry.data);
        }
      }
      failures.push({ variant: 'cookie+alternate-uid', reason: describeUnusableVariantResponse() });
    } catch (error) {
      failures.push({ variant: 'cookie+alternate-uid', reason: describeVariantError(error) });
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('getUserInfo', failures);
    return null;
  }

  override async login(
    baseUrl: string,
    username: string,
    password: string,
  ): Promise<{ success: boolean; accessToken?: string; username?: string; message?: string }> {
    try {
      const { data: res, cookieHeader } = await this.fetchJsonRawWithCookie<any>(`${baseUrl}/api/user/login`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      if (!res) {
        return { success: false, message: 'shield challenge blocked login' };
      }

      const accessToken = this.extractLoginAccessToken(res);
      if (res?.success && accessToken) {
        return {
          success: true,
          accessToken,
          username,
        };
      }
      if (res?.success && this.hasUsableSessionCookie(cookieHeader)) {
        return {
          success: true,
          accessToken: cookieHeader,
          username,
        };
      }

      return {
        success: false,
        message: this.extractResponseMessage(res) || '登录失败：未获取到可用会话凭据，请改用 Cookie/Token 导入',
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: this.formatRequestErrorMessage(err) || errMessage || '登录请求失败',
      };
    }
  }

  override async verifyToken(baseUrl: string, token: string, platformUserId?: number): Promise<TokenVerifyResult> {
    // Session cookies (NewAPI gorilla securecookie) must not start with a slow
    // OpenAI /v1/models probe — that path is for sk- API keys and used to hang the UI.
    if (!this.isSessionLikeCredential(token) || token.trim().startsWith('sk-')) {
      const openAiModels = await this.getOpenAiModels(baseUrl, token);
      if (openAiModels.length > 0) {
        return { tokenType: 'apikey', models: openAiModels };
      }
    }

    // Fast path: decode user id from session payload, then cookie + New-API-User.
    if (this.isSessionLikeCredential(token)) {
      const guessedIds = this.extractLikelyUserIds(token);
      const orderedIds = [
        ...(typeof platformUserId === 'number' && platformUserId > 0 ? [platformUserId] : []),
        ...guessedIds,
      ];
      for (const userId of orderedIds) {
        const cookieRes = await this.fetchUserSelfByCookie(baseUrl, token, userId);
        if (cookieRes?.success && cookieRes?.data) {
          const userInfo = this.parseUserInfo(cookieRes.data);
          const balance = this.parseBalance(cookieRes.data);
          let apiToken: string | null = null;
          try { apiToken = await this.getApiTokenWithUser(baseUrl, token, userId); } catch {}
          return { tokenType: 'session', userInfo, balance, apiToken };
        }
      }
    }

    try {
      const directRes = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (directRes?.success && directRes?.data) {
        const userId = directRes.data.id;
        const userInfo = this.parseUserInfo(directRes.data);
        const balance = this.parseBalance(directRes.data);
        let apiToken: string | null = null;
        try { apiToken = await this.getApiTokenWithUser(baseUrl, token, userId); } catch {}
        return { tokenType: 'session', userInfo, balance, apiToken };
      }

      if (directRes?.message?.includes('New-Api-User')) {
        const userId = platformUserId || await this.probeUserId(baseUrl, token);
        if (userId) {
          const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
            headers: this.authHeaders(token, userId),
          });
          if (res?.success && res?.data) {
            const userInfo = this.parseUserInfo(res.data);
            const balance = this.parseBalance(res.data);
            let apiToken: string | null = null;
            try { apiToken = await this.getApiTokenWithUser(baseUrl, token, userId); } catch {}
            return { tokenType: 'session', userInfo, balance, apiToken };
          }
          if (
            platformUserId &&
            typeof res?.message === 'string' &&
            /娑撳秴灏柊宄緈ismatch/i.test(res.message)
          ) {
            return { tokenType: 'unknown' };
          }
        }
      }
    } catch {}

    const cookieRes = await this.fetchUserSelfByCookie(baseUrl, token, platformUserId);
    if (cookieRes?.success && cookieRes?.data) {
      const userId = cookieRes.data.id;
      const userInfo = this.parseUserInfo(cookieRes.data);
      const balance = this.parseBalance(cookieRes.data);
      let apiToken: string | null = null;
      try { apiToken = await this.getApiTokenWithUser(baseUrl, token, userId); } catch {}
      return { tokenType: 'session', userInfo, balance, apiToken };
    }

    const cookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, token, platformUserId);
    if (cookieUserId) {
      const cookieRetry = await this.fetchUserSelfByCookie(baseUrl, token, cookieUserId);
      if (cookieRetry?.success && cookieRetry?.data) {
        const userInfo = this.parseUserInfo(cookieRetry.data);
        const balance = this.parseBalance(cookieRetry.data);
        let apiToken: string | null = null;
        try { apiToken = await this.getApiTokenWithUser(baseUrl, token, cookieUserId); } catch {}
        return { tokenType: 'session', userInfo, balance, apiToken };
      }
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('verifyToken', [
      { variant: 'session-chain', reason: describeUnusableVariantResponse('bearer/cookie/alternate-user-id all returned no user info') },
    ]);
    return { tokenType: 'unknown' };
  }

  private async probeUserId(baseUrl: string, accessToken: string): Promise<number | null> {
    const jwtId = this.tryDecodeUserId(accessToken);
    if (jwtId) {
      const valid = await this.testUserId(baseUrl, accessToken, jwtId);
      if (valid) return jwtId;
    }

    for (const id of this.buildUserIdProbeCandidates(accessToken)) {
      if (id === jwtId) continue;
      if (await this.testUserId(baseUrl, accessToken, id)) return id;
    }

    return null;
  }

  private async testUserId(baseUrl: string, accessToken: string, userId: number): Promise<boolean> {
    try {
      const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
        headers: this.authHeaders(accessToken, userId),
      });
      return res?.success === true && !!res?.data;
    } catch {
      return false;
    }
  }

  async checkin(baseUrl: string, accessToken: string, platformUserId?: number): Promise<CheckinResult> {
    let resolvedUserId: number | null;
    try { resolvedUserId = platformUserId || await this.discoverUserId(baseUrl, accessToken); }
    catch (error) {
      if (error instanceof NewApiShieldError) return { success: false, message: error.message };
      throw error;
    }
    let firstFailureMessage: string | undefined;
    const preferCookieFirst = this.isSessionLikeCredential(accessToken);

    const finalizeFailure = (message?: string) => ({
      success: false as const,
      message: classifyShieldGateFailureText(message) || message || 'checkin failed',
    });

    const tryBearerCheckin = async (): Promise<CheckinResult | null> => {
      try {
        const headers = this.authHeaders(accessToken, resolvedUserId || undefined);
        const res = await this.fetchJson<any>(`${baseUrl}/api/user/checkin`, {
          method: 'POST',
          headers,
        });
        if (res?.success) {
          return { success: true, message: res.message || 'checkin success', reward: res.data?.reward?.toString() };
        }
        const directMessage = this.extractResponseMessage(res);
        if (this.isAlreadyCheckedInMessage(directMessage)) {
          return { success: false, message: directMessage };
        }
        firstFailureMessage = this.rememberCheckinFailureMessage(firstFailureMessage, directMessage);
      } catch (err) {
        if (err instanceof NewApiShieldError && err.failure.terminal) return finalizeFailure(err.message);
        const parsed = this.formatRequestErrorMessage(err);
        // Aliyun WAF (acw_sc__v2) answers 200 + HTML to plain JSON fetches:
        // solve the challenge and resend the same Bearer checkin through the
        // shield-cookie flow (mirrors the balance-path recovery). Without
        // this, a challenged checkin surfaced as a raw JSON.parse error.
        if (parsed && this.isHtmlJsonParseErrorMessage(parsed)) {
          const shielded = await this.fetchJsonViaShield<any>(`${baseUrl}/api/user/checkin`, {
            method: 'POST',
            headers: this.authHeaders(accessToken, resolvedUserId || undefined),
          });
          if (shielded?.success) {
            return {
              success: true,
              message: shielded.message || 'checkin success',
              reward: shielded.data?.reward?.toString(),
            };
          }
          const shieldedMessage = this.extractResponseMessage(shielded);
          if (this.isAlreadyCheckedInMessage(shieldedMessage)) {
            return { success: false, message: shieldedMessage };
          }
          firstFailureMessage = this.rememberCheckinFailureMessage(firstFailureMessage, shieldedMessage);
        }
        firstFailureMessage = this.rememberCheckinFailureMessage(firstFailureMessage, parsed);
      }
      return null;
    };

    const tryCookieCheckin = async (cookieUserId?: number | null): Promise<CheckinResult | null> => {
      for (const cookie of this.buildCookieCandidates(accessToken)) {
        // Prefer the real NewAPI checkin endpoint first. /api/user/sign_in is a legacy alias and
        // often 404s, which previously polluted the final failure message.
        try {
          const headers: Record<string, string> = { Cookie: cookie };
          Object.assign(headers, this.userIdHeaders(cookieUserId));
          const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/checkin`, {
            method: 'POST',
            headers,
          });
          if (res?.success) {
            return { success: true, message: res.message || 'checkin success', reward: res.data?.reward?.toString() };
          }
          const cookieMessage = this.extractResponseMessage(res);
          if (this.isAlreadyCheckedInMessage(cookieMessage)) {
            return { success: false, message: cookieMessage };
          }
          firstFailureMessage = this.rememberCheckinFailureMessage(firstFailureMessage, cookieMessage);
        } catch (err) {
          if (err instanceof NewApiShieldError && err.failure.terminal) return finalizeFailure(err.message);
          const parsed = this.formatRequestErrorMessage(err);
          firstFailureMessage = this.rememberCheckinFailureMessage(firstFailureMessage, parsed);
        }

        try {
          const signInRes = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/sign_in`, {
            method: 'POST',
            body: '{}',
            headers: {
              Cookie: cookie,
              'X-Requested-With': 'XMLHttpRequest',
              ...this.userIdHeaders(cookieUserId),
            },
          });
          if (signInRes?.success) {
            return {
              success: true,
              message: signInRes.message || 'checked in',
              reward: signInRes.data?.reward?.toString(),
            };
          }
          const signInMessage = this.extractResponseMessage(signInRes);
          if (this.isAlreadyCheckedInMessage(signInMessage)) {
            return { success: false, message: signInMessage };
          }
          // Only keep sign_in message when we have nothing better; ignore pure missing-endpoint noise.
          if (!this.isMissingCheckinEndpointMessage(signInMessage)) {
            firstFailureMessage = this.rememberCheckinFailureMessage(firstFailureMessage, signInMessage);
          }
        } catch (err) {
          if (err instanceof NewApiShieldError && err.failure.terminal) return finalizeFailure(err.message);
          const parsed = this.formatRequestErrorMessage(err);
          if (!this.isMissingCheckinEndpointMessage(parsed)) {
            firstFailureMessage = this.rememberCheckinFailureMessage(firstFailureMessage, parsed);
          }
        }
      }

      return null;
    };

    if (!preferCookieFirst) {
      const bearerResult = await tryBearerCheckin();
      if (bearerResult) return bearerResult;
      if (firstFailureMessage && !this.shouldFallbackToCookieCheckin(firstFailureMessage)) {
        return finalizeFailure(firstFailureMessage);
      }
    }

    const initialCookieResult = await tryCookieCheckin(resolvedUserId);
    if (initialCookieResult) return initialCookieResult;

    const alternateCookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, accessToken, resolvedUserId);
    if (alternateCookieUserId && alternateCookieUserId !== resolvedUserId) {
      const retriedCookieResult = await tryCookieCheckin(alternateCookieUserId);
      if (retriedCookieResult) return retriedCookieResult;
    }

    // Session credentials: cookie path is authoritative. Only try Bearer afterwards as a last resort.
    if (preferCookieFirst && !this.isAlreadyCheckedInMessage(firstFailureMessage)) {
      const bearerResult = await tryBearerCheckin();
      if (bearerResult) return bearerResult;
    }

    if (this.isMissingCheckinEndpointMessage(firstFailureMessage)) {
      const cookieSessionFailureMessage = await this.detectCookieSessionFailureMessage(
        baseUrl,
        accessToken,
        [resolvedUserId, alternateCookieUserId],
      );
      if (cookieSessionFailureMessage) {
        return finalizeFailure(cookieSessionFailureMessage);
      }
    }

    return finalizeFailure(firstFailureMessage);
  }

  async getBalance(baseUrl: string, accessToken: string, platformUserId?: number): Promise<BalanceInfo> {
    const resolvedUserId = platformUserId || await this.discoverUserId(baseUrl, accessToken);
    let failureMessage: string | null = null;
    const rememberFailure = (message?: string | null) => {
      const text = typeof message === 'string' ? message.trim() : '';
      if (!text) return;
      if (!failureMessage) {
        failureMessage = text;
        return;
      }
      if ((this.isHtmlJsonParseErrorMessage(failureMessage) || /上游.*风控挑战/.test(failureMessage)) && !this.isHtmlJsonParseErrorMessage(text)) {
        failureMessage = text;
      }
    };

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user/self`, {
        headers: this.authHeaders(accessToken, resolvedUserId || undefined),
      });
      if (res?.success && res?.data) {
        return this.parseBalance(res.data);
      }
      rememberFailure(typeof res?.message === 'string' ? res.message : null);
    } catch (err) {
      if (err instanceof NewApiShieldError && err.failure.terminal) throw err;
      const message = this.formatRequestErrorMessage(err);
      rememberFailure(message);
      // Aliyun WAF (acw_sc__v2) answers 200 + HTML to plain JSON fetches. Solve
      // the challenge and resend the same Bearer probe through the shield-cookie
      // flow (covers managed management tokens on WAF-protected New API sites).
      if (message && this.isHtmlJsonParseErrorMessage(message)) {
        const shielded = await this.fetchJsonViaShield<any>(`${baseUrl}/api/user/self`, {
          headers: this.authHeaders(accessToken, resolvedUserId || undefined),
        });
        if (shielded?.success && shielded?.data) {
          return this.parseBalance(shielded.data);
        }
      }
    }

    const cookieRes = await this.fetchUserSelfByCookie(
      baseUrl,
      accessToken,
      resolvedUserId || undefined,
      rememberFailure,
    );
    if (cookieRes?.success && cookieRes?.data) {
      return this.parseBalance(cookieRes.data);
    }

    const cookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, accessToken, resolvedUserId);
    if (cookieUserId) {
      const cookieRetry = await this.fetchUserSelfByCookie(baseUrl, accessToken, cookieUserId, rememberFailure);
      if (cookieRetry?.success && cookieRetry?.data) {
        return this.parseBalance(cookieRetry.data);
      }
    }

    const humanizedFailure = classifyShieldGateFailureText(failureMessage);
    throw new Error(humanizedFailure || failureMessage || 'failed to fetch balance');
  }

  async getModels(baseUrl: string, token: string, platformUserId?: number, options?: ModelDiscoveryOptions): Promise<string[]> {
    const openAiModels = await this.getOpenAiModels(baseUrl, token, options);
    if (openAiModels.length > 0) return openAiModels;

    const userId = platformUserId || await this.discoverUserId(baseUrl, token);
    if (userId) {
      try {
        const res = await this.fetchJson<any>(`${baseUrl}/api/user/models`, {
          headers: this.authHeaders(token, userId),
        });
        if (Array.isArray(res?.data)) {
          return res.data.filter(Boolean);
        }
        if (res?.data && typeof res.data === 'object') {
          return Object.keys(res.data).filter(Boolean);
        }
      } catch {}
    }

    const cookieModels = await this.getSessionModelsByCookie(baseUrl, token, userId || platformUserId);
    if (cookieModels.length > 0) return cookieModels;

    const alternateCookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, token, userId || platformUserId);
    if (alternateCookieUserId) {
      const fallbackModels = await this.getSessionModelsByCookie(baseUrl, token, alternateCookieUserId);
      if (fallbackModels.length > 0) return fallbackModels;
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('getModels', [
      { variant: 'session-chain', reason: describeUnusableVariantResponse('bearer/cookie/alternate-user-id all returned nothing') },
    ]);
    return [];
  }

  async issueManagementToken(
    baseUrl: string,
    sessionCredential: string,
    platformUserId?: number,
  ): Promise<string | null> {
    const resolvedUserId = platformUserId || await this.probeUserIdByCookie(baseUrl, sessionCredential);
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of this.buildCookieCandidates(sessionCredential).entries()) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        Object.assign(headers, this.userIdHeaders(resolvedUserId));
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/token`, { headers });
        const token = typeof res?.data === 'string' ? res.data.trim() : '';
        if (res?.success && token) return token;
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeUnusableVariantResponse() });
      } catch (error) {
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeVariantError(error) });
      }
    }
    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('issueManagementToken', failures);
    return null;
  }

  async getApiToken(baseUrl: string, accessToken: string, platformUserId?: number): Promise<string | null> {
    const userId = platformUserId || await this.discoverUserId(baseUrl, accessToken);
    const tokens = await this.getApiTokensWithUser(baseUrl, accessToken, userId);
    return tokens.find((token) => token.enabled !== false)?.key || tokens[0]?.key || null;
  }

  async getApiTokens(baseUrl: string, accessToken: string, platformUserId?: number): Promise<ApiTokenInfo[]> {
    const userId = platformUserId || await this.discoverUserId(baseUrl, accessToken);
    return this.getApiTokensWithUser(baseUrl, accessToken, userId);
  }

  private async getApiTokenWithUser(baseUrl: string, accessToken: string, userId: number | null): Promise<string | null> {
    const tokens = await this.getApiTokensWithUser(baseUrl, accessToken, userId);
    return tokens.find((token) => token.enabled !== false)?.key || tokens[0]?.key || null;
  }

  async createApiToken(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
    options?: CreateApiTokenOptions,
  ): Promise<boolean> {
    const payload = JSON.stringify(this.buildDefaultTokenPayload(options));
    const resolvedUserId = platformUserId || await this.discoverUserId(baseUrl, accessToken);

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/token/`, {
        method: 'POST',
        headers: this.authHeaders(accessToken, resolvedUserId || undefined),
        body: payload,
      });
      if (res?.success) return true;
    } catch {}

    const cookieUserId = resolvedUserId || await this.probeUserIdByCookie(baseUrl, accessToken);
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of this.buildCookieCandidates(accessToken).entries()) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        Object.assign(headers, this.userIdHeaders(cookieUserId));
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/token/`, {
          method: 'POST',
          headers,
          body: payload,
        });
        if (res?.success) return true;
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeUnusableVariantResponse() });
      } catch (error) {
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeVariantError(error) });
      }
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('createApiToken', failures);
    return false;
  }

  async getUserGroups(baseUrl: string, accessToken: string, platformUserId?: number): Promise<string[]> {
    const resolvedUserId = platformUserId || await this.discoverUserId(baseUrl, accessToken);
    const dedupe = (groups: string[]) => Array.from(new Set(groups.map((item) => item.trim()).filter(Boolean)));
    let terminalError: string | null = null;

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user/self/groups`, {
        headers: this.authHeaders(accessToken, resolvedUserId || undefined),
      });
      if (res?.success === false) {
        terminalError = terminalError || this.resolveGroupFetchErrorMessage(res);
      }
      const parsed = dedupe(this.parseGroupKeys(res));
      if (parsed.length > 0) return parsed;
    } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user_group_map`, {
        headers: this.authHeaders(accessToken, resolvedUserId || undefined),
      });
      if (res?.success === false) {
        terminalError = terminalError || this.resolveGroupFetchErrorMessage(res);
      }
      const parsed = dedupe(this.parseGroupKeys(res));
      if (parsed.length > 0) return parsed;
    } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }

    const cookieUserId = resolvedUserId || await this.probeUserIdByCookie(baseUrl, accessToken);
    for (const cookie of this.buildCookieCandidates(accessToken)) {
      const headers: Record<string, string> = { Cookie: cookie };
      Object.assign(headers, this.userIdHeaders(cookieUserId));

      try {
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self/groups`, { headers });
        if (res?.success === false) {
          terminalError = terminalError || this.resolveGroupFetchErrorMessage(res);
        }
        const parsed = dedupe(this.parseGroupKeys(res));
        if (parsed.length > 0) return parsed;
      } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }

      try {
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user_group_map`, { headers });
        if (res?.success === false) {
          terminalError = terminalError || this.resolveGroupFetchErrorMessage(res);
        }
        const parsed = dedupe(this.parseGroupKeys(res));
        if (parsed.length > 0) return parsed;
      } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }
    }

    if (terminalError) {
      throw new Error(terminalError);
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    throw new Error('拉取分组失败：未获得有效的上游分组响应');
  }

  async deleteApiToken(
    baseUrl: string,
    accessToken: string,
    tokenKey: string,
    platformUserId?: number,
  ): Promise<DeleteApiTokenResult> {
    const targetKey = this.normalizeTokenKeyForCompare(tokenKey);
    if (!targetKey) return 'unconfirmed';
    const resolvedUserId = platformUserId || await this.discoverUserId(baseUrl, accessToken);

    const pickTokenId = (items: any[]): number | null => {
      // Mask-aware match: upstream lists often return masked keys (e.g.
      // `lDon...gPZG`), so strict equality never finds the target.
      // `locateTokenInKeys` also resolves the two failure modes:
      //   present  → we hold the exact id to revoke;
      //   absent   → the fully-enumerated list proves it is gone;
      //   otherwise ambiguous → unconfirmed (fail closed).
      const verdict = locateTokenInKeys(
        targetKey,
        items.map((item) => (typeof item?.key === 'string' ? item.key : null)),
      );
      if (verdict.present && verdict.index !== null) {
        const id = Number.parseInt(String(items[verdict.index]?.id), 10);
        return Number.isFinite(id) && id > 0 ? id : null;
      }
      return null;
    };

    const isTokenListVerified = (items: any[], list: any): boolean => {
      const total = list.data?.total ?? list.total;
      // A single page does not prove absence when more pages may hide the
      // target. Fail closed rather than claiming revocation.
      const complete = total !== undefined
        ? Number.isFinite(Number(total)) && Number(total) >= 0 && Number(total) <= items.length
        : items.length < 100;
      if (!complete) return false;
      // Only an absence verdict covers the whole list: if any key was
      // ambiguous (short/unreadable mask), we cannot rule the target out.
      const verdict = locateTokenInKeys(
        targetKey,
        items.map((item) => (typeof item?.key === 'string' ? item.key : null)),
      );
      return !verdict.present && verdict.absent;
    };

    let tokenId: number | null = null;
    let tokenListVerified = false;
    const observeTokenList = (list: any) => {
      if (!list || list.success === false) return;
      const items = [list.data, list.data?.items, list.data?.data, list.items, list.list, list.data?.list]
        .find(Array.isArray) as any[] | undefined;
      if (!items) return;
      tokenId = pickTokenId(items);
      if (isTokenListVerified(items, list)) tokenListVerified = true;
    };

    try {
      const list = await this.fetchJson<any>(`${baseUrl}/api/token/?p=0&size=100`, {
        headers: this.authHeaders(accessToken, resolvedUserId || undefined),
      });
      observeTokenList(list);
      if (tokenId) {
        const res = await this.fetchJson<any>(`${baseUrl}/api/token/${tokenId}`, {
          method: 'DELETE',
          headers: this.authHeaders(accessToken, resolvedUserId || undefined),
        });
        return res?.success ? 'deleted' : 'unconfirmed';
      }
    } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }

    const cookieUserId = resolvedUserId || await this.probeUserIdByCookie(baseUrl, accessToken);
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of this.buildCookieCandidates(accessToken).entries()) {
      const headers: Record<string, string> = { Cookie: cookie };
      Object.assign(headers, this.userIdHeaders(cookieUserId));

      try {
        if (!tokenId) {
          const list = await this.fetchJsonRaw<any>(`${baseUrl}/api/token/?p=0&size=100`, { headers });
          observeTokenList(list);
        }

        if (!tokenId) continue;

        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/token/${tokenId}`, {
          method: 'DELETE',
          headers,
        });
        if (res?.success) return 'deleted';
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeUnusableVariantResponse() });
      } catch (error) {
        if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
        failures.push({ variant: `cookie#${cookieIndex + 1}`, reason: describeVariantError(error) });
      }
    }

    // The upstream list was fully enumerated and the target key is not among
    // it, so the token is already gone there and local deletion is safe.
    if (!tokenId && tokenListVerified) return 'verified-absent';
    if (!tokenId) return 'unconfirmed';
    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('deleteApiToken', failures);
    return 'unconfirmed';
  }

  private async getApiTokensWithUser(baseUrl: string, accessToken: string, userId: number | null): Promise<ApiTokenInfo[]> {
    const failures: PlatformVariantFailure[] = [];
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/token/?p=0&size=100`, {
        headers: this.authHeaders(accessToken, userId || undefined),
      });
      const normalized = this.normalizeTokenItems(this.parseTokenItems(res));
      if (normalized.length > 0) return normalized;
      if (this.isTokenListResponse(res)) return [];
    } catch (error) {
      failures.push({ variant: 'bearer/user-id', reason: describeVariantError(error) });
    }

    const cookieTokens = await this.getApiTokensByCookie(baseUrl, accessToken, userId);
    if (cookieTokens.length > 0) return cookieTokens;

    const alternateCookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, accessToken, userId);
    if (alternateCookieUserId) {
      const fallbackTokens = await this.getApiTokensByCookie(baseUrl, accessToken, alternateCookieUserId);
      if (fallbackTokens.length > 0) return fallbackTokens;
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    logAllVariantsFailed('getApiTokensWithUser', failures);
    return [];
  }
}
