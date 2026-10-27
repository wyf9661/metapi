import type { ApiTokenInfo, BalanceInfo, CreateApiTokenOptions, UserInfo } from './base.js';

export function tryDecodeUserId(token: string): number | null {
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

export function authHeaders(accessToken: string, userId?: number): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      ...userIdHeaders(userId),
    };
  }

export function userIdHeaders(userId?: number | null): Record<string, string> {
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

export function buildCookieCandidates(token: string): string[] {
    const trimmed = (token || '').trim();
    if (!trimmed) return [];

    const raw = trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
    const candidates: string[] = [];

    // Only treat as a full Cookie header when it looks like name=value pairs.
    if (looksLikeCookiePairCredential(raw)) {
      candidates.push(raw);
    }

    candidates.push(`session=${raw}`);
    candidates.push(`token=${raw}`);

    return Array.from(new Set(candidates));
  }

export function decodeBase64BufferLoose(value: string): Buffer | null {
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

export function decodeGobSignedInt(encoded: Buffer): number | null {
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

export function extractGobFieldInts(payload: Buffer, fieldName: string): number[] {
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
          push(decodeGobSignedInt(payload.subarray(valueStart, valueEnd)));
        }
      }

      start = position + marker.length;
    }

    return ids;
  }

export function extractLikelyUserIds(token: string): number[] {
    const ids: number[] = [];
    const push = (value: unknown) => {
      const n = Number.parseInt(String(value), 10);
      if (Number.isNaN(n)) return;
      if (n <= 0 || n > 10_000_000) return;
      if (!ids.includes(n)) ids.push(n);
    };

    const raw = (token || '').trim();
    if (!raw) return ids;

    const cookieCandidates = buildCookieCandidates(raw);
    const sessionValues = new Set<string>();
    for (const candidate of cookieCandidates) {
      const match = candidate.match(/(?:^|;\s*)session=([^;]+)/i);
      if (match?.[1]) sessionValues.add(match[1].trim());
    }

    if (raw && !raw.includes('=')) {
      sessionValues.add(raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw);
    }

    for (const sessionValue of sessionValues) {
      const decodedBuffer = decodeBase64BufferLoose(sessionValue);
      if (!decodedBuffer) continue;

      const decoded = decodedBuffer.toString('utf8');

      const payloadCandidates: string[] = [decoded];
      const payloadBuffers: Buffer[] = [decodedBuffer];
      const parts = decoded.split('|');
      if (parts.length >= 2) {
        const middlePayloadBuffer = decodeBase64BufferLoose(parts[1]);
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
        for (const value of extractGobFieldInts(payload, 'id')) {
          push(value);
        }
      }
    }

    return ids;
  }

export function buildUserIdProbeCandidates(token: string): number[] {
    const candidates: number[] = [];
    const push = (value: number | null) => {
      if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return;
      if (!candidates.includes(value)) candidates.push(value);
    };

    push(tryDecodeUserId(token));
    for (const guessed of extractLikelyUserIds(token)) {
      push(guessed);
    }
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 50, 100, 8899, 11494]) {
      push(id);
    }

    return candidates;
  }

export function parseTokenItems(payload: any): any[] {
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.data?.items)) return payload.data.items;
    if (Array.isArray(payload?.data?.data)) return payload.data.data;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.list)) return payload.list;
    if (Array.isArray(payload?.data?.list)) return payload.data.list;
    return [];
  }

export function isTokenListResponse(payload: any): boolean {
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

export function normalizeTokenKeyForCompare(value?: string | null): string {
    const trimmed = (value || '').trim();
    return trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
  }

export function parseGroupKeys(payload: any): string[] {
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

export function resolveGroupFetchErrorMessage(payload: any): string {
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

export function normalizeTokenItems(items: any[]): ApiTokenInfo[] {
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

export function parseUserInfo(data: any): UserInfo {
    return {
      username: data?.username || data?.display_name || '',
      displayName: data?.display_name,
      email: data?.email,
      role: data?.role,
    };
  }

export function parseBalance(data: any): BalanceInfo {
    const quota = (data?.quota || 0) / 500000;
    const used = (data?.used_quota || 0) / 500000;
    const total = quota + used;
    const todayIncome = Number.isFinite(data?.today_income) ? (data.today_income / 500000) : undefined;
    const todayQuotaConsumption = Number.isFinite(data?.today_quota_consumption) ? (data.today_quota_consumption / 500000) : undefined;
    return { balance: quota, used, quota: total, todayIncome, todayQuotaConsumption };
  }

export function extractLoginAccessToken(payload: any): string | null {
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

export function buildDefaultTokenPayload(options?: CreateApiTokenOptions): Record<string, unknown> {
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

export function parseJsonSafe<T>(text: string): T | null {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

export function extractHtmlErrorSummary(payloadRaw: string): string | null {
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

export function formatRequestErrorMessage(err: unknown): string | null {
    const raw = typeof (err as { message?: unknown })?.message === 'string'
      ? (err as { message: string }).message.trim()
      : '';
    if (!raw) return null;

    const httpMatch = raw.match(/^(HTTP\s+\d+):\s*([\s\S]+)$/);
    if (!httpMatch) return raw;

    const [, prefix, payloadRaw] = httpMatch;
    const payload = parseJsonSafe<any>(payloadRaw);
    const bodyMessage = extractResponseMessage(payload);
    if (bodyMessage) return `${prefix}: ${bodyMessage}`;
    const htmlSummary = extractHtmlErrorSummary(payloadRaw);
    if (htmlSummary) return `${prefix}: ${htmlSummary}`;
    return raw;
  }

export function extractResponseMessage(payload: any): string {
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

export function isHtmlJsonParseErrorMessage(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    return (
      text.includes("unexpected token '<'")
      || (text.includes('not valid json') && (text.includes('<html') || text.includes('<script')))
    );
  }

export function hasUsableSessionCookie(cookieHeader: string): boolean {
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

export function isAlreadyCheckedInMessage(message?: string | null): boolean {
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

export function looksLikeCookiePairCredential(token: string): boolean {
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

export function isSessionLikeCredential(token: string): boolean {
    const raw = (token || '').trim();
    if (!raw) return false;
    if (looksLikeCookiePairCredential(raw)) return true;
    // NewAPI session cookies are typically long base64-ish values, not sk-/eyJ tokens.
    if (raw.startsWith('sk-') || raw.startsWith('eyJ')) return false;
    return raw.length >= 80;
  }

export function rememberCheckinFailureMessage(current: string | undefined, next?: string | null): string | undefined {
    const incoming = typeof next === 'string' ? next.trim() : '';
    if (!incoming) return current;
    if (!current) return incoming;
    // Never let later auth noise override an already-checked-in result.
    if (isAlreadyCheckedInMessage(current)) return current;
    if (isAlreadyCheckedInMessage(incoming)) return incoming;
    // Prefer non-auth business errors over generic unauthorized once we have something better.
    if (isCookieSessionFailureMessage(current) && !isCookieSessionFailureMessage(incoming)) {
      return incoming;
    }
    return incoming;
  }

export function shouldFallbackToCookieCheckin(message?: string | null): boolean {
    if (!message) return true;
    if (isAlreadyCheckedInMessage(message)) return false;
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

export function isMissingCheckinEndpointMessage(message?: string | null): boolean {
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

export function isCookieSessionFailureMessage(message?: string | null): boolean {
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

export function extractOpenAiModels(payload: any): string[] {
    if (!Array.isArray(payload?.data)) return [];
    return payload.data.map((m: any) => m?.id).filter(Boolean);
  }
