export function isCloudflareChallenge(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return text.includes('cloudflare') || text.includes('cf challenge') || text.includes('challenge required');
}

const SESSION_TOKEN_REBIND_HINT = '请在中转站重新生成系统访问令牌后重新绑定账号';

function isEndpointDispatchDeniedMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i.test(message)
    || text.includes('dispatch denied')
  );
}

export function isTokenExpiredError(input: { status?: number; message?: string | null }): boolean {
  const rawMessage = input.message || '';
  const text = (input.message || '').toLowerCase();
  if (isEndpointDispatchDeniedMessage(rawMessage)) return false;
  if (!text) return false;

  // Filter out HTML pages / WAF challenge content.
  if (text.startsWith('<!doctype') || text.startsWith('<html') || text.includes('<script')) return false;

  // NewAPI-like sites may return this when session context is missing for an action,
  // which does not always mean the account token is expired.
  if (text.includes('未登录且未提供 access token')) return false;

  // HTTP status (especially 401) alone is NOT sufficient evidence of token expiry:
  // WAF blocks, missing headers, gateway default wording ("Unauthorized"),
  // rate-limit/fraud shields all produce 401 with generic text. Only explicit
  // credential-invalid/expired language counts, identical for 401 and non-401 paths.
  const tokenPhrase = text.includes('token') || text.includes('令牌') || text.includes('访问令牌');
  const hasInvalid = text.includes('invalid') || text.includes('无效') || text.includes('失效');
  const hasExpired = text.includes('expired') || text.includes('expire') || text.includes('过期');

  const explicitExpiredPhrase = (
    text.includes('jwt expired')
    || text.includes('token expired')
    || text.includes('expired token')
    || text.includes('token 已过期')
    || text.includes('令牌已过期')
    || text.includes('token 已失效')
    || text.includes('令牌已失效')
    || text.includes('登录已过期')
    || text.includes('登录已失效')
    || text.includes('登录状态已过期')
    || text.includes('未登录或登录已过期')
  );

  const explicitInvalidPhrase = (
    /invalid\s+access\s+token/.test(text)
    || /access\s+token\s+is\s+invalid/.test(text)
    || /invalid\s+token/.test(text)
    || text.includes('access token 无效')
    || text.includes('访问令牌无效')
    || text.includes('token 无效')
    || text.includes('令牌无效')
  );

  return (
    explicitExpiredPhrase
    || explicitInvalidPhrase
    || (tokenPhrase && (hasInvalid || hasExpired))
  );
}

export function appendSessionTokenRebindHint(message?: string | null): string {
  const raw = String(message || '').trim();
  if (!raw) return raw;
  if (raw.includes(SESSION_TOKEN_REBIND_HINT)) return raw;

  const text = raw.toLowerCase();
  const looksLikeInvalidAccessToken = (
    raw.includes('无权进行此操作，access token 无效') ||
    /invalid\s+access\s+token/.test(text) ||
    /access\s+token\s+is\s+invalid/.test(text) ||
    /access\s+token.*无效/.test(raw)
  );
  if (!looksLikeInvalidAccessToken) return raw;

  return `${raw}，${SESSION_TOKEN_REBIND_HINT}`;
}
