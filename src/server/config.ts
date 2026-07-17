import 'dotenv/config';
import type { FastifyServerOptions } from 'fastify';
import { normalizePayloadRulesConfig } from './services/payloadRules.js';

const DEFAULT_REQUEST_BODY_LIMIT = 20 * 1024 * 1024;
const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_GEMINI_CLI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const DEFAULT_GEMINI_CLI_CLIENT_SECRET = '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';
export const TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING = 30 * 24 * 60 * 60;
export const INSECURE_DEFAULT_AUTH_TOKEN = 'change-me-admin-token';
export const INSECURE_DEFAULT_PROXY_TOKEN = 'change-me-proxy-sk-token';
export const MIN_PRODUCTION_SECRET_LENGTH = 8;

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseOptionalSecret(value: string | undefined): string {
  return (value || '').trim();
}

function parseJsonValue(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseDbType(value: string | undefined): 'sqlite' | 'mysql' | 'postgres' {
  const normalized = (value || 'sqlite').trim().toLowerCase();
  if (normalized === 'mysql') return 'mysql';
  if (normalized === 'postgres' || normalized === 'postgresql') return 'postgres';
  return 'sqlite';
}

export function normalizeTokenRouterFailureCooldownMaxSec(value: unknown): number | null {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return Math.min(
    TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING,
    Math.max(1, Math.trunc(normalized)),
  );
}

function parseListenHost(env: NodeJS.ProcessEnv): string {
  return (env.HOST || '0.0.0.0').trim() || '0.0.0.0';
}

export function buildConfig(env: NodeJS.ProcessEnv) {
  const dataDir = env.DATA_DIR || './data';

  return {
    authToken: env.AUTH_TOKEN || INSECURE_DEFAULT_AUTH_TOKEN,
    proxyToken: env.PROXY_TOKEN || INSECURE_DEFAULT_PROXY_TOKEN,
    // Production default: false — clients should use UI-generated managed keys.
    // Dev/test default: true for backward compatibility with PROXY_TOKEN.
    allowGlobalProxyToken: parseBoolean(
      env.ALLOW_GLOBAL_PROXY_TOKEN,
      (env.NODE_ENV || '').toLowerCase() !== 'production',
    ),
    deployHelperToken: parseOptionalSecret(env.DEPLOY_HELPER_TOKEN || env.UPDATE_CENTER_HELPER_TOKEN),
    codexClientId: parseOptionalSecret(env.CODEX_CLIENT_ID) || DEFAULT_CODEX_CLIENT_ID,
    claudeClientId: parseOptionalSecret(env.CLAUDE_CLIENT_ID) || DEFAULT_CLAUDE_CLIENT_ID,
    claudeClientSecret: parseOptionalSecret(env.CLAUDE_CLIENT_SECRET),
    geminiCliClientId: parseOptionalSecret(env.GEMINI_CLI_CLIENT_ID) || DEFAULT_GEMINI_CLI_CLIENT_ID,
    geminiCliClientSecret: parseOptionalSecret(env.GEMINI_CLI_CLIENT_SECRET) || DEFAULT_GEMINI_CLI_CLIENT_SECRET,
    systemProxyUrl: env.SYSTEM_PROXY_URL || '',
    // Prefer a dedicated secret; fall back only for local/dev compatibility.
    accountCredentialSecret: env.ACCOUNT_CREDENTIAL_SECRET
      || env.AUTH_TOKEN
      || INSECURE_DEFAULT_AUTH_TOKEN,
    checkinCron: env.CHECKIN_CRON || '0 8 * * *',
    checkinScheduleMode: (env.CHECKIN_SCHEDULE_MODE || 'cron').trim().toLowerCase() === 'interval'
      ? 'interval' as const
      : 'cron' as const,
    checkinIntervalHours: Math.min(24, Math.max(1, Math.trunc(parseNumber(env.CHECKIN_INTERVAL_HOURS, 6)))),
    balanceRefreshCron: env.BALANCE_REFRESH_CRON || '0 * * * *',
    logCleanupCron: env.LOG_CLEANUP_CRON || '0 6 * * *',
    logCleanupConfigured: false,
    logCleanupUsageLogsEnabled: parseBoolean(env.LOG_CLEANUP_USAGE_LOGS_ENABLED, false),
    logCleanupProgramLogsEnabled: parseBoolean(env.LOG_CLEANUP_PROGRAM_LOGS_ENABLED, false),
    logCleanupRetentionDays: Math.max(1, Math.trunc(parseNumber(env.LOG_CLEANUP_RETENTION_DAYS, 30))),
    webhookUrl: env.WEBHOOK_URL || '',
    webhookSecret: env.WEBHOOK_SECRET || '',
    barkUrl: env.BARK_URL || '',
    webhookEnabled: parseBoolean(env.WEBHOOK_ENABLED, true),
    barkEnabled: parseBoolean(env.BARK_ENABLED, true),
    serverChanEnabled: parseBoolean(env.SERVERCHAN_ENABLED, true),
    serverChanKey: env.SERVERCHAN_KEY || '',
    telegramEnabled: parseBoolean(env.TELEGRAM_ENABLED, false),
    telegramApiBaseUrl: 'https://api.telegram.org',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',
    telegramUseSystemProxy: parseBoolean(env.TELEGRAM_USE_SYSTEM_PROXY, false),
    telegramMessageThreadId: (env.TELEGRAM_MESSAGE_THREAD_ID || '').trim(),
    smtpEnabled: parseBoolean(env.SMTP_ENABLED, false),
    smtpHost: env.SMTP_HOST || '',
    smtpPort: parseInt(env.SMTP_PORT || '587'),
    smtpSecure: parseBoolean(env.SMTP_SECURE, false),
    smtpUser: env.SMTP_USER || '',
    smtpPass: env.SMTP_PASS || '',
    smtpFrom: env.SMTP_FROM || '',
    smtpTo: env.SMTP_TO || '',
    notifyCooldownSec: Math.max(0, Math.trunc(parseNumber(env.NOTIFY_COOLDOWN_SEC, 300))),
    tunnelDashboardAccess: env.TUNNEL_DASHBOARD_ACCESS === 'true',
    tunnelEnabled: env.TUNNEL_ENABLED === 'true',
    adminIpAllowlist: parseCsvList(env.ADMIN_IP_ALLOWLIST),
    port: Math.trunc(parseNumber(env.PORT, 4000)),
    listenHost: parseListenHost(env),
    dataDir,
    dbType: parseDbType(env.DB_TYPE),
    dbUrl: (env.DB_URL || '').trim(),
    dbSsl: parseBoolean(env.DB_SSL, false),
    // When DB_SSL=true, verify certificates by default (set DB_SSL_REJECT_UNAUTHORIZED=false for self-signed).
    dbSslRejectUnauthorized: parseBoolean(env.DB_SSL_REJECT_UNAUTHORIZED, true),
    // trustProxy: honor X-Forwarded-For from reverse proxies. Set TRUST_PROXY=false when exposed directly.
    trustProxy: parseBoolean(env.TRUST_PROXY, true),
    // Only constrain to N hops when explicitly configured; otherwise preserve legacy trust-all behavior.
    trustProxyHops: env.TRUST_PROXY_HOPS !== undefined
      ? Math.max(1, Math.trunc(parseNumber(env.TRUST_PROXY_HOPS, 1)))
      : null,
    requestBodyLimit: DEFAULT_REQUEST_BODY_LIMIT,
    routingFallbackUnitCost: Math.max(1e-6, parseNumber(env.ROUTING_FALLBACK_UNIT_COST, 1)),
    proxyFirstByteTimeoutSec: Math.max(0, Math.trunc(parseNumber(env.PROXY_FIRST_BYTE_TIMEOUT_SEC, 0))),
    tokenRouterFailureCooldownMaxSec: normalizeTokenRouterFailureCooldownMaxSec(
      parseNumber(env.TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC, TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING),
    ) ?? TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING,
    tokenRouterCacheTtlMs: Math.max(100, Math.trunc(parseNumber(env.TOKEN_ROUTER_CACHE_TTL_MS, 1_500))),
    proxyMaxChannelAttempts: Math.max(1, Math.trunc(parseNumber(env.PROXY_MAX_CHANNEL_ATTEMPTS, 3))),
    // Wall-clock budget for multi-channel failover. 0 disables. Default 8s so
    // clients see a terminal error before their own long timeouts.
    proxyChannelFailoverBudgetMs: Math.max(0, Math.trunc(parseNumber(env.PROXY_CHANNEL_FAILOVER_BUDGET_MS, 8_000))),
    proxyStickySessionEnabled: parseBoolean(env.PROXY_STICKY_SESSION_ENABLED, true),
    proxyStickySessionTtlMs: Math.max(30_000, Math.trunc(parseNumber(env.PROXY_STICKY_SESSION_TTL_MS, 30 * 60 * 1000))),
    proxySessionChannelConcurrencyLimit: Math.max(0, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_CONCURRENCY_LIMIT, 2))),
    proxySessionChannelQueueWaitMs: Math.max(0, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_QUEUE_WAIT_MS, 1_500))),
    proxySessionChannelLeaseTtlMs: Math.max(5_000, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_LEASE_TTL_MS, 90_000))),
    proxySessionChannelLeaseKeepaliveMs: Math.max(1_000, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_LEASE_KEEPALIVE_MS, 15_000))),
    codexUpstreamWebsocketEnabled: parseBoolean(env.CODEX_UPSTREAM_WEBSOCKET_ENABLED, false),
    responsesCompactFallbackToResponsesEnabled: parseBoolean(env.RESPONSES_COMPACT_FALLBACK_TO_RESPONSES_ENABLED, false),
    disableCrossProtocolFallback: parseBoolean(env.DISABLE_CROSS_PROTOCOL_FALLBACK, false),
    proxyDebugTraceEnabled: parseBoolean(env.PROXY_DEBUG_TRACE_ENABLED, false),
    proxyDebugCaptureHeaders: parseBoolean(env.PROXY_DEBUG_CAPTURE_HEADERS, true),
    proxyDebugCaptureBodies: parseBoolean(env.PROXY_DEBUG_CAPTURE_BODIES, false),
    proxyDebugCaptureStreamChunks: parseBoolean(env.PROXY_DEBUG_CAPTURE_STREAM_CHUNKS, false),
    proxyDebugTargetSessionId: (env.PROXY_DEBUG_TARGET_SESSION_ID || '').trim(),
    proxyDebugTargetClientKind: (env.PROXY_DEBUG_TARGET_CLIENT_KIND || '').trim(),
    proxyDebugTargetModel: (env.PROXY_DEBUG_TARGET_MODEL || '').trim(),
    proxyDebugRetentionHours: Math.max(1, Math.trunc(parseNumber(env.PROXY_DEBUG_RETENTION_HOURS, 24))),
    proxyDebugMaxBodyBytes: Math.max(1024, Math.trunc(parseNumber(env.PROXY_DEBUG_MAX_BODY_BYTES, 262_144))),
    openAiServiceTierRules: parseJsonValue(env.OPENAI_SERVICE_TIER_RULES_JSON || env.OPENAI_SERVICE_TIER_RULES),
    // Batch probe is intentionally disabled for this fork unless explicitly allowed.
    // MODEL_AVAILABILITY_PROBE_ALLOW=true is required before MODEL_AVAILABILITY_PROBE_ENABLED can take effect.
    modelAvailabilityProbeAllow: parseBoolean(env.MODEL_AVAILABILITY_PROBE_ALLOW, false),
    modelAvailabilityProbeEnabled: parseBoolean(env.MODEL_AVAILABILITY_PROBE_ALLOW, false)
      && parseBoolean(env.MODEL_AVAILABILITY_PROBE_ENABLED, false),
    modelAvailabilityProbeIntervalMs: Math.max(60_000, Math.trunc(parseNumber(env.MODEL_AVAILABILITY_PROBE_INTERVAL_MS, 30 * 60 * 1000))),
    modelAvailabilityProbeTimeoutMs: Math.max(3_000, Math.trunc(parseNumber(env.MODEL_AVAILABILITY_PROBE_TIMEOUT_MS, 15_000))),
    modelAvailabilityProbeConcurrency: Math.max(1, Math.min(2, Math.trunc(parseNumber(env.MODEL_AVAILABILITY_PROBE_CONCURRENCY, 1)))),
    proxyLogRetentionDays: Math.max(0, Math.trunc(parseNumber(env.PROXY_LOG_RETENTION_DAYS, 30))),
    proxyLogRetentionPruneIntervalMinutes: Math.max(1, Math.trunc(parseNumber(env.PROXY_LOG_RETENTION_PRUNE_INTERVAL_MINUTES, 30))),
    proxyFileRetentionDays: Math.max(0, Math.trunc(parseNumber(env.PROXY_FILE_RETENTION_DAYS, 30))),
    proxyFileRetentionPruneIntervalMinutes: Math.max(1, Math.trunc(parseNumber(env.PROXY_FILE_RETENTION_PRUNE_INTERVAL_MINUTES, 60))),
    proxyErrorKeywords: parseCsvList(env.PROXY_ERROR_KEYWORDS),
    proxyEmptyContentFailEnabled: parseBoolean(env.PROXY_EMPTY_CONTENT_FAIL, false),
    globalBlockedBrands: [] as string[],
    globalAllowedModels: [] as string[],
    codexResponsesWebsocketBeta: parseOptionalSecret(env.CODEX_RESPONSES_WEBSOCKET_BETA) || 'responses_websockets=2026-02-06',
    codexHeaderDefaults: {
      userAgent: parseOptionalSecret(env.CODEX_HEADER_DEFAULTS_USER_AGENT),
      betaFeatures: parseOptionalSecret(env.CODEX_HEADER_DEFAULTS_BETA_FEATURES),
    },
    payloadRules: normalizePayloadRulesConfig(parseJsonValue(env.PAYLOAD_RULES_JSON || env.PAYLOAD_RULES)),
    routingWeights: {
      baseWeightFactor: parseNumber(env.BASE_WEIGHT_FACTOR, 0.5),
      valueScoreFactor: parseNumber(env.VALUE_SCORE_FACTOR, 0.5),
      costWeight: parseNumber(env.COST_WEIGHT, 0.4),
      balanceWeight: parseNumber(env.BALANCE_WEIGHT, 0.3),
      usageWeight: parseNumber(env.USAGE_WEIGHT, 0.3),
    },
  };
}

export const config = buildConfig(process.env);

export function buildFastifyOptions(
  appConfig: ReturnType<typeof buildConfig>,
): FastifyServerOptions {
  return {
    logger: true,
    // false | true | hop count — avoid unconditionally trusting client-supplied XFF.
    // Default preserves legacy trust-all (true); TRUST_PROXY=false disables; TRUST_PROXY_HOPS=N constrains.
    trustProxy: appConfig.trustProxy
      ? (appConfig.trustProxyHops ?? true)
      : false,
    bodyLimit: appConfig.requestBodyLimit,
  };
}

export function isInsecureDefaultSecret(value: string | null | undefined): boolean {
  const normalized = (value || '').trim();
  return (
    normalized.length === 0
    || normalized === INSECURE_DEFAULT_AUTH_TOKEN
    || normalized === INSECURE_DEFAULT_PROXY_TOKEN
    || normalized === '123456'
    || normalized === 'REPLACE_WITH_STRONG_RANDOM_SECRET'
  );
}

/**
 * Production startup gate. Dev/test keep insecure defaults for convenience.
 * Set ALLOW_INSECURE_DEFAULTS=true to bypass (not recommended).
 */
export function assertProductionSecurity(
  appConfig: ReturnType<typeof buildConfig>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const nodeEnv = (env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv !== 'production') return;
  if (parseBoolean(env.ALLOW_INSECURE_DEFAULTS, false)) {
    console.warn('[security] ALLOW_INSECURE_DEFAULTS=true — production security checks skipped');
    return;
  }

  const problems: string[] = [];
  if (isInsecureDefaultSecret(appConfig.authToken) || appConfig.authToken.trim().length < MIN_PRODUCTION_SECRET_LENGTH) {
    problems.push(
      `AUTH_TOKEN must be a strong unique value (>=${MIN_PRODUCTION_SECRET_LENGTH} chars), not the built-in default`,
    );
  }
  if (appConfig.allowGlobalProxyToken) {
    if (isInsecureDefaultSecret(appConfig.proxyToken) || appConfig.proxyToken.trim().length < MIN_PRODUCTION_SECRET_LENGTH) {
      problems.push(
        'PROXY_TOKEN is enabled (ALLOW_GLOBAL_PROXY_TOKEN) but still uses an insecure/default value — generate managed keys in the UI or set a strong PROXY_TOKEN',
      );
    }
  }
  if (
    isInsecureDefaultSecret(appConfig.accountCredentialSecret)
    || appConfig.accountCredentialSecret.trim().length < MIN_PRODUCTION_SECRET_LENGTH
  ) {
    problems.push(
      `ACCOUNT_CREDENTIAL_SECRET must be a strong unique value (>=${MIN_PRODUCTION_SECRET_LENGTH} chars)`,
    );
  }
  if (appConfig.accountCredentialSecret === appConfig.authToken) {
    problems.push(
      'ACCOUNT_CREDENTIAL_SECRET must differ from AUTH_TOKEN (encryption key and admin login must not share a secret)',
    );
  }

  if (problems.length === 0) return;

  const message = [
    '[security] Refusing to start in production with insecure configuration:',
    ...problems.map((item) => `  - ${item}`),
    'Fix: set strong AUTH_TOKEN + ACCOUNT_CREDENTIAL_SECRET in env, prefer UI-generated downstream keys (ALLOW_GLOBAL_PROXY_TOKEN=false).',
    'Emergency only: ALLOW_INSECURE_DEFAULTS=true',
  ].join('\n');
  throw new Error(message);
}
