/**
 * Site protocol profile — first-class capability flags for NewAPI-class gateways.
 * Stored as JSON on sites.protocol_profile; also inferred from Codex custom headers.
 */

export type SiteCredentialModeHint = 'auto' | 'api_key' | 'session';

export type SiteProtocolProfile = {
  /** Prefer /v1/responses before chat/messages when building endpoint candidates. */
  preferResponses: boolean;
  /** Upstream expects Codex client fingerprint (User-Agent / originator). */
  requireCodexClient: boolean;
  /** Hint for account verify UX (session cookie vs sk-). */
  credentialMode: SiteCredentialModeHint;
  /** Optional free-form note for operators. */
  notes?: string;
};

export const DEFAULT_SITE_PROTOCOL_PROFILE: SiteProtocolProfile = {
  preferResponses: false,
  requireCodexClient: false,
  credentialMode: 'auto',
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return null;
}

function asCredentialMode(value: unknown): SiteCredentialModeHint {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'api_key' || raw === 'apikey' || raw === 'token') return 'api_key';
  if (raw === 'session' || raw === 'cookie') return 'session';
  return 'auto';
}

export function parseSiteProtocolProfile(raw: unknown): SiteProtocolProfile {
  const obj = asObject(raw);
  if (!obj) return { ...DEFAULT_SITE_PROTOCOL_PROFILE };
  return {
    preferResponses: asBoolean(obj.preferResponses ?? obj.prefer_responses) ?? false,
    requireCodexClient: asBoolean(obj.requireCodexClient ?? obj.require_codex_client) ?? false,
    credentialMode: asCredentialMode(obj.credentialMode ?? obj.credential_mode),
    notes: typeof obj.notes === 'string' ? obj.notes : undefined,
  };
}

export function serializeSiteProtocolProfile(profile: SiteProtocolProfile): string {
  const payload: SiteProtocolProfile = {
    preferResponses: !!profile.preferResponses,
    requireCodexClient: !!profile.requireCodexClient,
    credentialMode: profile.credentialMode || 'auto',
  };
  if (profile.notes && profile.notes.trim()) {
    payload.notes = profile.notes.trim();
  }
  return JSON.stringify(payload);
}

/** Infer Codex / responses preference from site custom header JSON or text. */
export function inferProtocolProfileFromCustomHeaders(customHeaders: unknown): Partial<SiteProtocolProfile> {
  const raw = typeof customHeaders === 'string'
    ? customHeaders
    : customHeaders == null
      ? ''
      : JSON.stringify(customHeaders);
  const lower = raw.toLowerCase();
  if (!lower) return {};
  const looksCodex = (
    lower.includes('codex_cli_rs')
    || lower.includes('openai-codex')
    || lower.includes('codex_vscode')
    || (lower.includes('user-agent') && lower.includes('codex'))
    || (lower.includes('originator') && lower.includes('codex'))
  );
  if (!looksCodex) return {};
  return {
    preferResponses: true,
    requireCodexClient: true,
  };
}

export function resolveSiteProtocolProfile(input: {
  protocolProfile?: unknown;
  customHeaders?: unknown;
}): SiteProtocolProfile {
  const base = parseSiteProtocolProfile(input.protocolProfile);
  const inferred = inferProtocolProfileFromCustomHeaders(input.customHeaders);
  return {
    preferResponses: base.preferResponses || !!inferred.preferResponses,
    requireCodexClient: base.requireCodexClient || !!inferred.requireCodexClient,
    credentialMode: base.credentialMode || 'auto',
    notes: base.notes,
  };
}

export function siteProtocolPrefersResponses(input: {
  protocolProfile?: unknown;
  customHeaders?: unknown;
}): boolean {
  return resolveSiteProtocolProfile(input).preferResponses;
}

/**
 * Soft routing affinity for sites with an explicit modern protocol profile.
 * Codex/responses-oriented gateways get a mild boost so they win ties against
 * generic OpenAI-compat rows that only work after more conversion work.
 * Pure demotion is avoided: MetAPI can convert chat→responses for Codex sites.
 */
export function siteProtocolAffinityFactor(input: {
  protocolProfile?: unknown;
  customHeaders?: unknown;
}): number {
  const profile = resolveSiteProtocolProfile(input);
  if (profile.requireCodexClient && profile.preferResponses) return 1.18;
  if (profile.preferResponses || profile.requireCodexClient) return 1.1;
  return 1;
}

export type MappedUpstreamError = {
  code: string;
  message: string;
  retryable: boolean;
};

/**
 * Map raw upstream failures to stable, operator-friendly messages for clients.
 */
export function mapUpstreamErrorForClient(status: number, upstreamErrorText?: string | null): MappedUpstreamError {
  const text = (upstreamErrorText || '').trim();
  const lower = text.toLowerCase();

  if (
    lower.includes('codex_requires_responses_protocol')
    || lower.includes('codex clients may only use the openai responses protocol')
    || lower.includes('only use the openai responses protocol')
  ) {
    return {
      code: 'codex_requires_responses',
      message: '该上游仅允许 Codex/Responses 协议。请在站点勾选「Codex 客户端特征」，或确认 MetAPI 已自动走 /v1/responses。',
      retryable: false,
    };
  }

  if (
    lower.includes('no available channel')
    || lower.includes('无可用渠道')
    || lower.includes('无可用账号')
    || lower.includes('no_available_account')
    || lower.includes('no available account')
  ) {
    return {
      code: 'upstream_no_capacity',
      message: '上游当前无可用账号/渠道（供应不足），不是 MetAPI 路由配置错误。请稍后重试或更换站点。',
      retryable: true,
    };
  }

  if (
    lower.includes('unsupported model')
    || lower.includes('model not found')
    || lower.includes('does not exist')
    || lower.includes('不支持所选模型')
    || lower.includes('模型') && lower.includes('不支持')
  ) {
    return {
      code: 'model_unsupported',
      message: '上游不支持该模型。可切换其他站点通道，或检查路由中的上游真名映射。',
      retryable: true,
    };
  }

  if (status === 401 || lower.includes('invalid api key') || lower.includes('invalid access token') || lower.includes('unauthorized')) {
    return {
      code: 'upstream_auth',
      message: '上游鉴权失败（API Key / Session 无效或过期）。请在连接管理中重新验证凭证。',
      retryable: true,
    };
  }

  if (status === 429 || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('quota')) {
    return {
      code: 'upstream_rate_limit',
      message: '上游限流或配额不足，MetAPI 将尝试切换其他通道（若仍有可用通道）。',
      retryable: true,
    };
  }

  if (status >= 500) {
    return {
      code: 'upstream_5xx',
      message: text || `上游服务错误 HTTP ${status}`,
      retryable: true,
    };
  }

  return {
    code: 'upstream_error',
    message: text || `上游返回 HTTP ${status}`,
    retryable: status === 408 || status === 409 || status === 425 || status === 429 || status >= 500,
  };
}
