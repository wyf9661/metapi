import { ApiTokenInfo, BasePlatformAdapter, CheckinResult, BalanceInfo, UserInfo, TokenVerifyResult, CreateApiTokenOptions, type DeleteApiTokenResult, type ModelDiscoveryOptions, type SiteAnnouncement } from './base.js';
import type { RequestInit as UndiciRequestInit } from 'undici';
import {
  describeUnusableVariantResponse,
  describeVariantError,
  logAllVariantsFailed,
  type PlatformVariantFailure,
} from './platformVariantFailures.js';
import { fetchJsonWithShieldCookieRetry, classifyShieldGateFailureText, NewApiShieldError } from './newApiShield.js';
import { getTurnstileSolverSettings, solveTurnstileToken, isTurnstileRequiredMessage } from '../turnstileSolver.js';
import { CODEX_CLI_USER_AGENT } from '../../shared/codexClientFamily.js';
import { locateTokenInKeys } from '../../shared/tokenMask.js';
import {
  tryDecodeUserId,
  authHeaders,
  userIdHeaders,
  buildCookieCandidates,
  extractLikelyUserIds,
  buildUserIdProbeCandidates,
  parseTokenItems,
  isTokenListResponse,
  normalizeTokenKeyForCompare,
  parseGroupKeys,
  resolveGroupFetchErrorMessage,
  normalizeTokenItems,
  parseUserInfo,
  parseBalance,
  extractLoginAccessToken,
  buildDefaultTokenPayload,
  formatRequestErrorMessage,
  extractResponseMessage,
  isHtmlJsonParseErrorMessage,
  hasUsableSessionCookie,
  isAlreadyCheckedInMessage,
  looksLikeCookiePairCredential,
  isSessionLikeCredential,
  rememberCheckinFailureMessage,
  shouldFallbackToCookieCheckin,
  isMissingCheckinEndpointMessage,
  isCookieSessionFailureMessage,
  extractOpenAiModels,
} from './newApiPure.js';

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

  // Kept as thin instance wrappers: newApi.test.ts reaches these three through
  // `(adapter as any)` to exercise the raw session-cookie decoding path.
  isSessionLikeCredential(token: string): boolean {
    return isSessionLikeCredential(token);
  }

  looksLikeCookiePairCredential(token: string): boolean {
    return looksLikeCookiePairCredential(token);
  }

  extractLikelyUserIds(token: string): number[] {
    return extractLikelyUserIds(token);
  }
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



































  private async detectCookieSessionFailureMessage(
    baseUrl: string,
    accessToken: string,
    candidateUserIds: Array<number | null | undefined>,
  ): Promise<string | null> {
    let failureMessage: string | null = null;
    const rememberFailure = (message: string) => {
      if (failureMessage) return;
      const text = message.trim();
      if (!isCookieSessionFailureMessage(text)) return;
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
    for (const [cookieIndex, cookie] of buildCookieCandidates(token).entries()) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        Object.assign(headers, userIdHeaders(platformUserId));
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
    const candidates = buildUserIdProbeCandidates(token);
    const cookieCandidates = buildCookieCandidates(token);
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of cookieCandidates.entries()) {
      for (const id of candidates) {
        try {
          const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
            headers: { Cookie: cookie, ...userIdHeaders(id) },
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
    for (const [cookieIndex, cookie] of buildCookieCandidates(token).entries()) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        Object.assign(headers, userIdHeaders(userId));
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/token/?p=0&size=100`, { headers });
        const normalized = normalizeTokenItems(parseTokenItems(res));
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
    for (const [cookieIndex, cookie] of buildCookieCandidates(token).entries()) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        Object.assign(headers, userIdHeaders(userId));
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


  private async getOpenAiModelsViaShieldCookie(baseUrl: string, token: string, options?: ModelDiscoveryOptions): Promise<string[]> {
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of buildCookieCandidates(token).entries()) {
      try {
        const { data } = await fetchJsonWithShieldCookieRetry<any>(`${baseUrl}/v1/models`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Cookie: cookie,
            ...(options?.requireCodexClient ? CODEX_DISCOVERY_FINGERPRINT_HEADERS : {}),
          },
        });
        const models = extractOpenAiModels(data);
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
    const shouldTryShieldCookie = looksLikeCookiePairCredential(token);
    if (shouldTryShieldCookie) {
      const shieldModels = await this.getOpenAiModelsViaShieldCookie(baseUrl, token, options);
      if (shieldModels.length > 0) return shieldModels;
    }

    // API keys only: session cookies are not valid OpenAI bearer tokens.
    if (isSessionLikeCredential(token) && !token.trim().startsWith('sk-')) {
      return [];
    }

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/v1/models`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options?.requireCodexClient ? CODEX_DISCOVERY_FINGERPRINT_HEADERS : {}),
        },
      });
      return extractOpenAiModels(res);
    } catch {
      return [];
    }
  }

  private async discoverUserId
(baseUrl: string, accessToken: string): Promise<number | null> {
    const jwtId = tryDecodeUserId(accessToken);
    if (jwtId) {
      try {
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
          headers: authHeaders(accessToken, jwtId),
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
        return parseUserInfo(directRes.data);
      }
      failures.push({ variant: 'bearer', reason: describeUnusableVariantResponse() });
    } catch (error) {
      failures.push({ variant: 'bearer', reason: describeVariantError(error) });
    }

    try {
      const cookieRes = await this.fetchUserSelfByCookie(baseUrl, accessToken, platformUserId);
      if (cookieRes?.success && cookieRes?.data) {
        return parseUserInfo(cookieRes.data);
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
          return parseUserInfo(cookieRetry.data);
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

      const accessToken = extractLoginAccessToken(res);
      if (res?.success && accessToken) {
        return {
          success: true,
          accessToken,
          username,
        };
      }
      if (res?.success && hasUsableSessionCookie(cookieHeader)) {
        return {
          success: true,
          accessToken: cookieHeader,
          username,
        };
      }

      return {
        success: false,
        message: extractResponseMessage(res) || '登录失败：未获取到可用会话凭据，请改用 Cookie/Token 导入',
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: formatRequestErrorMessage(err) || errMessage || '登录请求失败',
      };
    }
  }

  override async verifyToken(baseUrl: string, token: string, platformUserId?: number): Promise<TokenVerifyResult> {
    // Session cookies (NewAPI gorilla securecookie) must not start with a slow
    // OpenAI /v1/models probe — that path is for sk- API keys and used to hang the UI.
    if (!isSessionLikeCredential(token) || token.trim().startsWith('sk-')) {
      const openAiModels = await this.getOpenAiModels(baseUrl, token);
      if (openAiModels.length > 0) {
        return { tokenType: 'apikey', models: openAiModels };
      }
    }

    // Fast path: decode user id from session payload, then cookie + New-API-User.
    if (isSessionLikeCredential(token)) {
      const guessedIds = extractLikelyUserIds(token);
      const orderedIds = [
        ...(typeof platformUserId === 'number' && platformUserId > 0 ? [platformUserId] : []),
        ...guessedIds,
      ];
      for (const userId of orderedIds) {
        const cookieRes = await this.fetchUserSelfByCookie(baseUrl, token, userId);
        if (cookieRes?.success && cookieRes?.data) {
          const userInfo = parseUserInfo(cookieRes.data);
          const balance = parseBalance(cookieRes.data);
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
        const userInfo = parseUserInfo(directRes.data);
        const balance = parseBalance(directRes.data);
        let apiToken: string | null = null;
        try { apiToken = await this.getApiTokenWithUser(baseUrl, token, userId); } catch {}
        return { tokenType: 'session', userInfo, balance, apiToken };
      }

      if (directRes?.message?.includes('New-Api-User')) {
        const userId = platformUserId || await this.probeUserId(baseUrl, token);
        if (userId) {
          const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
            headers: authHeaders(token, userId),
          });
          if (res?.success && res?.data) {
            const userInfo = parseUserInfo(res.data);
            const balance = parseBalance(res.data);
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
      const userInfo = parseUserInfo(cookieRes.data);
      const balance = parseBalance(cookieRes.data);
      let apiToken: string | null = null;
      try { apiToken = await this.getApiTokenWithUser(baseUrl, token, userId); } catch {}
      return { tokenType: 'session', userInfo, balance, apiToken };
    }

    const cookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, token, platformUserId);
    if (cookieUserId) {
      const cookieRetry = await this.fetchUserSelfByCookie(baseUrl, token, cookieUserId);
      if (cookieRetry?.success && cookieRetry?.data) {
        const userInfo = parseUserInfo(cookieRetry.data);
        const balance = parseBalance(cookieRetry.data);
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
    const jwtId = tryDecodeUserId(accessToken);
    if (jwtId) {
      const valid = await this.testUserId(baseUrl, accessToken, jwtId);
      if (valid) return jwtId;
    }

    for (const id of buildUserIdProbeCandidates(accessToken)) {
      if (id === jwtId) continue;
      if (await this.testUserId(baseUrl, accessToken, id)) return id;
    }

    return null;
  }

  private async testUserId(baseUrl: string, accessToken: string, userId: number): Promise<boolean> {
    try {
      const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
        headers: authHeaders(accessToken, userId),
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
    const preferCookieFirst = isSessionLikeCredential(accessToken);

    const finalizeFailure = (message?: string) => ({
      success: false as const,
      message: classifyShieldGateFailureText(message) || message || 'checkin failed',
    });

    const tryBearerCheckin = async (): Promise<CheckinResult | null> => {
      try {
        const headers = authHeaders(accessToken, resolvedUserId || undefined);
        const res = await this.fetchJson<any>(`${baseUrl}/api/user/checkin`, {
          method: 'POST',
          headers,
        });
        if (res?.success) {
          return { success: true, message: res.message || 'checkin success', reward: res.data?.reward?.toString() };
        }
        const directMessage = extractResponseMessage(res);
        if (isAlreadyCheckedInMessage(directMessage)) {
          return { success: false, message: directMessage };
        }
        // Cloudflare Turnstile gate (new-api: "Turnstile token 为空"): solve the
        // widget via the configured solver and retry with the token as the
        // `turnstile` URL query param (the new-api middleware reads c.Query).
        if (isTurnstileRequiredMessage(directMessage)) {
          const solved = await this.tryTurnstileCheckin(baseUrl, () => authHeaders(accessToken, resolvedUserId || undefined));
          if (solved) return solved;
        }
        firstFailureMessage = rememberCheckinFailureMessage(firstFailureMessage, directMessage);
      } catch (err) {
        if (err instanceof NewApiShieldError && err.failure.terminal) return finalizeFailure(err.message);
        const parsed = formatRequestErrorMessage(err);
        // Aliyun WAF (acw_sc__v2) answers 200 + HTML to plain JSON fetches:
        // solve the challenge and resend the same Bearer checkin through the
        // shield-cookie flow (mirrors the balance-path recovery). Without
        // this, a challenged checkin surfaced as a raw JSON.parse error.
        if (parsed && isHtmlJsonParseErrorMessage(parsed)) {
          const shielded = await this.fetchJsonViaShield<any>(`${baseUrl}/api/user/checkin`, {
            method: 'POST',
            headers: authHeaders(accessToken, resolvedUserId || undefined),
          });
          if (shielded?.success) {
            return {
              success: true,
              message: shielded.message || 'checkin success',
              reward: shielded.data?.reward?.toString(),
            };
          }
          const shieldedMessage = extractResponseMessage(shielded);
          if (isAlreadyCheckedInMessage(shieldedMessage)) {
            return { success: false, message: shieldedMessage };
          }
          firstFailureMessage = rememberCheckinFailureMessage(firstFailureMessage, shieldedMessage);
        }
        firstFailureMessage = rememberCheckinFailureMessage(firstFailureMessage, parsed);
      }
      return null;
    };

    const tryCookieCheckin = async (cookieUserId?: number | null): Promise<CheckinResult | null> => {
      for (const cookie of buildCookieCandidates(accessToken)) {
        // Prefer the real NewAPI checkin endpoint first. /api/user/sign_in is a legacy alias and
        // often 404s, which previously polluted the final failure message.
        try {
          const headers: Record<string, string> = { Cookie: cookie };
          Object.assign(headers, userIdHeaders(cookieUserId));
          const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/checkin`, {
            method: 'POST',
            headers,
          });
          if (res?.success) {
            return { success: true, message: res.message || 'checkin success', reward: res.data?.reward?.toString() };
          }
          const cookieMessage = extractResponseMessage(res);
          if (isAlreadyCheckedInMessage(cookieMessage)) {
            return { success: false, message: cookieMessage };
          }
          if (isTurnstileRequiredMessage(cookieMessage)) {
            const solved = await this.tryTurnstileCheckin(baseUrl, () => ({
              Cookie: cookie,
              ...userIdHeaders(cookieUserId),
            }));
            if (solved) return solved;
          }
          firstFailureMessage = rememberCheckinFailureMessage(firstFailureMessage, cookieMessage);
        } catch (err) {
          if (err instanceof NewApiShieldError && err.failure.terminal) return finalizeFailure(err.message);
          const parsed = formatRequestErrorMessage(err);
          firstFailureMessage = rememberCheckinFailureMessage(firstFailureMessage, parsed);
        }

        try {
          const signInRes = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/sign_in`, {
            method: 'POST',
            body: '{}',
            headers: {
              Cookie: cookie,
              'X-Requested-With': 'XMLHttpRequest',
              ...userIdHeaders(cookieUserId),
            },
          });
          if (signInRes?.success) {
            return {
              success: true,
              message: signInRes.message || 'checked in',
              reward: signInRes.data?.reward?.toString(),
            };
          }
          const signInMessage = extractResponseMessage(signInRes);
          if (isAlreadyCheckedInMessage(signInMessage)) {
            return { success: false, message: signInMessage };
          }
          // Only keep sign_in message when we have nothing better; ignore pure missing-endpoint noise.
          if (!isMissingCheckinEndpointMessage(signInMessage)) {
            firstFailureMessage = rememberCheckinFailureMessage(firstFailureMessage, signInMessage);
          }
        } catch (err) {
          if (err instanceof NewApiShieldError && err.failure.terminal) return finalizeFailure(err.message);
          const parsed = formatRequestErrorMessage(err);
          if (!isMissingCheckinEndpointMessage(parsed)) {
            firstFailureMessage = rememberCheckinFailureMessage(firstFailureMessage, parsed);
          }
        }
      }

      return null;
    };

    if (!preferCookieFirst) {
      const bearerResult = await tryBearerCheckin();
      if (bearerResult) return bearerResult;
      if (firstFailureMessage && !shouldFallbackToCookieCheckin(firstFailureMessage)) {
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
    if (preferCookieFirst && !isAlreadyCheckedInMessage(firstFailureMessage)) {
      const bearerResult = await tryBearerCheckin();
      if (bearerResult) return bearerResult;
    }

    if (isMissingCheckinEndpointMessage(firstFailureMessage)) {
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

  /**
   * Cloudflare Turnstile 绕过：当签到请求被 new-api 的 Turnstile 中间件拦下
   * （"Turnstile token 为空"），用配置的求解器（云端或自建）实时求解 token，
   * 再以 `?turnstile=<token>` 重放签到请求。
   *
   * token 单次有效 + 300 秒过期，因此每次都实时求解，不缓存。
   * 返回 null 表示无需/无法求解（无配置、取不到 sitekey、求解失败），
   * 让上层走原本的失败分类逻辑。
   */
  private async tryTurnstileCheckin(
    baseUrl: string,
    buildHeaders: () => Record<string, string>,
  ): Promise<CheckinResult | null> {
    const settings = await getTurnstileSolverSettings();
    if (!settings) return null;

    // 站点 /api/status 公开下发 sitekey
    let sitekey: string | null = null;
    try {
      const status = await this.fetchJson<any>(`${baseUrl}/api/status`);
      sitekey = status?.data?.turnstile_site_key
        || status?.data?.turnstileSiteKey
        || null;
    } catch {
      return null;
    }
    if (!sitekey) return null;

    const pageUrl = `${baseUrl.replace(/\/+$/, '')}/sign-in`;
    const solved = await solveTurnstileToken(settings, { pageUrl, sitekey });
    if (!solved.success || !solved.token) return null;

    try {
      const url = new URL(`${baseUrl.replace(/\/+$/, '')}/api/user/checkin`);
      url.searchParams.set('turnstile', solved.token);
      const res = await this.fetchJson<any>(url.toString(), {
        method: 'POST',
        headers: buildHeaders(),
      });
      if (res?.success) {
        return {
          success: true,
          message: res.message || 'checkin success',
          reward: res.data?.reward?.toString(),
        };
      }
      const retryMessage = extractResponseMessage(res);
      if (isAlreadyCheckedInMessage(retryMessage)) {
        return { success: false, message: retryMessage };
      }
    } catch {
      // 重放失败不吞掉原始 Turnstile 失败分类；这里返回 null 走原逻辑
    }
    return null;
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
      if ((isHtmlJsonParseErrorMessage(failureMessage) || /上游.*风控挑战/.test(failureMessage)) && !isHtmlJsonParseErrorMessage(text)) {
        failureMessage = text;
      }
    };

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user/self`, {
        headers: authHeaders(accessToken, resolvedUserId || undefined),
      });
      if (res?.success && res?.data) {
        return parseBalance(res.data);
      }
      rememberFailure(typeof res?.message === 'string' ? res.message : null);
    } catch (err) {
      if (err instanceof NewApiShieldError && err.failure.terminal) throw err;
      const message = formatRequestErrorMessage(err);
      rememberFailure(message);
      // Aliyun WAF (acw_sc__v2) answers 200 + HTML to plain JSON fetches. Solve
      // the challenge and resend the same Bearer probe through the shield-cookie
      // flow (covers managed management tokens on WAF-protected New API sites).
      if (message && isHtmlJsonParseErrorMessage(message)) {
        const shielded = await this.fetchJsonViaShield<any>(`${baseUrl}/api/user/self`, {
          headers: authHeaders(accessToken, resolvedUserId || undefined),
        });
        if (shielded?.success && shielded?.data) {
          return parseBalance(shielded.data);
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
      return parseBalance(cookieRes.data);
    }

    const cookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, accessToken, resolvedUserId);
    if (cookieUserId) {
      const cookieRetry = await this.fetchUserSelfByCookie(baseUrl, accessToken, cookieUserId, rememberFailure);
      if (cookieRetry?.success && cookieRetry?.data) {
        return parseBalance(cookieRetry.data);
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
          headers: authHeaders(token, userId),
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
    for (const [cookieIndex, cookie] of buildCookieCandidates(sessionCredential).entries()) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        Object.assign(headers, userIdHeaders(resolvedUserId));
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
    const payload = JSON.stringify(buildDefaultTokenPayload(options));
    const resolvedUserId = platformUserId || await this.discoverUserId(baseUrl, accessToken);

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/token/`, {
        method: 'POST',
        headers: authHeaders(accessToken, resolvedUserId || undefined),
        body: payload,
      });
      if (res?.success) return true;
    } catch {}

    const cookieUserId = resolvedUserId || await this.probeUserIdByCookie(baseUrl, accessToken);
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of buildCookieCandidates(accessToken).entries()) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        Object.assign(headers, userIdHeaders(cookieUserId));
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
        headers: authHeaders(accessToken, resolvedUserId || undefined),
      });
      if (res?.success === false) {
        terminalError = terminalError || resolveGroupFetchErrorMessage(res);
      }
      const parsed = dedupe(parseGroupKeys(res));
      if (parsed.length > 0) return parsed;
    } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user_group_map`, {
        headers: authHeaders(accessToken, resolvedUserId || undefined),
      });
      if (res?.success === false) {
        terminalError = terminalError || resolveGroupFetchErrorMessage(res);
      }
      const parsed = dedupe(parseGroupKeys(res));
      if (parsed.length > 0) return parsed;
    } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }

    const cookieUserId = resolvedUserId || await this.probeUserIdByCookie(baseUrl, accessToken);
    for (const cookie of buildCookieCandidates(accessToken)) {
      const headers: Record<string, string> = { Cookie: cookie };
      Object.assign(headers, userIdHeaders(cookieUserId));

      try {
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self/groups`, { headers });
        if (res?.success === false) {
          terminalError = terminalError || resolveGroupFetchErrorMessage(res);
        }
        const parsed = dedupe(parseGroupKeys(res));
        if (parsed.length > 0) return parsed;
      } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }

      try {
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user_group_map`, { headers });
        if (res?.success === false) {
          terminalError = terminalError || resolveGroupFetchErrorMessage(res);
        }
        const parsed = dedupe(parseGroupKeys(res));
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
    const targetKey = normalizeTokenKeyForCompare(tokenKey);
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
        headers: authHeaders(accessToken, resolvedUserId || undefined),
      });
      observeTokenList(list);
      if (tokenId) {
        const res = await this.fetchJson<any>(`${baseUrl}/api/token/${tokenId}`, {
          method: 'DELETE',
          headers: authHeaders(accessToken, resolvedUserId || undefined),
        });
        return res?.success ? 'deleted' : 'unconfirmed';
      }
    } catch (error) {
      if (error instanceof NewApiShieldError && error.failure.terminal) throw error;
    }

    const cookieUserId = resolvedUserId || await this.probeUserIdByCookie(baseUrl, accessToken);
    const failures: PlatformVariantFailure[] = [];
    for (const [cookieIndex, cookie] of buildCookieCandidates(accessToken).entries()) {
      const headers: Record<string, string> = { Cookie: cookie };
      Object.assign(headers, userIdHeaders(cookieUserId));

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
        headers: authHeaders(accessToken, userId || undefined),
      });
      const normalized = normalizeTokenItems(parseTokenItems(res));
      if (normalized.length > 0) return normalized;
      if (isTokenListResponse(res)) return [];
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
