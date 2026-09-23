import 'dotenv/config';
import type { FastifyServerOptions } from 'fastify';
import { normalizePayloadRulesConfig } from './services/payloadRules.js';
import { normalizeRouteRoutingStrategy } from './services/routeRoutingStrategy.js';

// Request body size is intentionally not capped at the application layer —
// like one-api/new-api, raw-byte payload limits belong to the edge proxy and
// the upstreams. Capping here only breaks legitimate large agent payloads
// (base64 images, big tool outputs); context overflow is already handled
// semantically (400 max-context → request_validation).
const REQUEST_BODY_LIMIT_UNLIMITED = Number.MAX_SAFE_INTEGER;
const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_GEMINI_CLI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
export const TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING = 60 * 60;
export const INSECURE_DEFAULT_AUTH_TOKEN = 'change-me-admin-token';
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

function parseClampedWeight(value: string | undefined, fallback: number): number {
  const parsed = parseNumber(value, fallback);
  if (parsed < 0) return 0;
  if (parsed > 10) return 10;
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

export type ContextAwareRoutingMode = 'off' | 'exclude_known' | 'strict';

function parseContextAwareRoutingMode(value: string | undefined): ContextAwareRoutingMode {
  const normalized = (value || 'exclude_known').trim().toLowerCase();
  if (normalized === 'off' || normalized === 'false' || normalized === '0' || normalized === 'disabled') return 'off';
  if (normalized === 'strict') return 'strict';
  return 'exclude_known';
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
    codexClientId: parseOptionalSecret(env.CODEX_CLIENT_ID) || DEFAULT_CODEX_CLIENT_ID,
    claudeClientId: parseOptionalSecret(env.CLAUDE_CLIENT_ID) || DEFAULT_CLAUDE_CLIENT_ID,
    claudeClientSecret: parseOptionalSecret(env.CLAUDE_CLIENT_SECRET),
    geminiCliClientId: parseOptionalSecret(env.GEMINI_CLI_CLIENT_ID) || DEFAULT_GEMINI_CLI_CLIENT_ID,
    geminiCliClientSecret: parseOptionalSecret(env.GEMINI_CLI_CLIENT_SECRET),
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
    // Model discovery/rebuild runs on its own cadence (default every 30 min),
    // decoupled from the hourly balance pass. When both shared one pass, a
    // wedged upstream socket stalled the whole pass for hours and every later
    // model refresh was skipped via the in-flight guard (2026-09-09 CAIC).
    modelRefreshCron: env.MODEL_REFRESH_CRON || '*/30 * * * *',
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
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    // Only constrain to N hops when explicitly configured; otherwise preserve legacy trust-all behavior.
    trustProxyHops: env.TRUST_PROXY_HOPS !== undefined
      ? Math.max(1, Math.trunc(parseNumber(env.TRUST_PROXY_HOPS, 1)))
      : null,
    requestBodyLimit: REQUEST_BODY_LIMIT_UNLIMITED,
    routingFallbackUnitCost: Math.max(1e-6, parseNumber(env.ROUTING_FALLBACK_UNIT_COST, 1)),
    // Minimum probability floor (0.03-0.15) each healthy route candidate keeps
    // after balanced-v2 scoring, so new/small sites are actually tried instead
    // of being starved to ~0% by dominant sites. Decays as reliability is proven.
    routeProbabilityFloor: Math.min(0.15, Math.max(0.03, parseNumber(env.ROUTE_PROBABILITY_FLOOR, 0.05))),
    // When a session account hits quota/credit exhaustion (402 / insufficient
    // balance), immediately mark its balance exhausted (hard-exclude from
    // scoring) and re-verify asynchronously. Direct API-key accounts are never
    // touched (balance is unknown there, default 0 must not mean exhausted).
    routeQuotaExhaustionExclude: parseBoolean(env.ROUTE_QUOTA_EXHAUSTION_EXCLUDE, true),
    // Default 30s: cut dead/slow channels before full generation hangs failover.
    // 0 still disables. Streaming requests that already emit the first token continue.
    proxyFirstByteTimeoutSec: Math.max(0, Math.trunc(parseNumber(env.PROXY_FIRST_BYTE_TIMEOUT_SEC, 30))),
    tokenRouterFailureCooldownMaxSec: normalizeTokenRouterFailureCooldownMaxSec(
      parseNumber(env.TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC, TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING),
    ) ?? TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING,
    tokenRouterCacheTtlMs: Math.max(100, Math.trunc(parseNumber(env.TOKEN_ROUTER_CACHE_TTL_MS, 1_500))),
    // Fallback when countEligibleChannels fails (static path).
    proxyMaxChannelAttempts: Math.max(1, Math.trunc(parseNumber(env.PROXY_MAX_CHANNEL_ATTEMPTS, 5))),
    // Soft cap on live multi-channel failover (min(pool, cap)). Default 8 —
    // prevents 20+ free-pool channels from thrashing one client request.
    proxyChannelFailoverMaxAttempts: Math.max(
      1,
      Math.trunc(parseNumber(env.PROXY_CHANNEL_FAILOVER_MAX_ATTEMPTS, 8)),
    ),
    // Explicit wall-clock budget (ms). 0 = live path uses soft default 30s for
    // multi-channel pools (see getProxyEffectiveFailoverBudgetMs).
    proxyChannelFailoverBudgetMs: Math.max(0, Math.trunc(parseNumber(env.PROXY_CHANNEL_FAILOVER_BUDGET_MS, 0))),
    // Short sleep before switching channels after a transient-recovering
    // failure (WAF 403 / bare 403 / 429 / 5xx). These often clear within
    // seconds; a small delay between channel attempts improves success on
    // recovery windows. Default 1200ms; set 0 to disable (immediate
    // failover, legacy behavior).
    proxyFailoverBackoffMs: Math.max(0, Math.min(5_000, Math.trunc(parseNumber(env.PROXY_FAILOVER_BACKOFF_MS, 1_200)))),
    // Grace period (ms) for transient-recovering failures (WAF 403 / 429 / 5xx):
    // stay on the same channel instead of immediately failing over, giving the
    // upstream a chance to self-heal. 0 = disabled (legacy immediate failover).
    // Default 8s; inspired by codex-watchdog's interruptAfterMs concept.
    proxyRecoveringGraceMs: Math.max(0, Math.min(30_000, Math.trunc(parseNumber(env.PROXY_RECOVERING_GRACE_MS, 8_000)))),
    proxyStickySessionEnabled: parseBoolean(env.PROXY_STICKY_SESSION_ENABLED, true),
    // Soft sticky default 30s so dense same-key traffic rebalances across sites.
    proxyStickySessionTtlMs: Math.max(30_000, Math.trunc(parseNumber(env.PROXY_STICKY_SESSION_TTL_MS, 30_000))),
    // Consecutive last-success uses before one balanced-v2 exploration. The
    // last-success channel remains a fallback if exploration fails.
    proxyLastSuccessExplorationInterval: Math.max(
      1,
      Math.trunc(parseNumber(env.PROXY_LAST_SUCCESS_EXPLORATION_INTERVAL, 10)),
    ),
    // Sticky max-hits only applies to session affinity; last-success uses its
    // own exploration interval above.
    proxyStickyMaxHits: Math.max(1, Math.trunc(parseNumber(env.PROXY_STICKY_MAX_HITS, 5))),
    // Probability (0-1) that a first-hop request skips sticky and last-success
    // affinity and goes directly to balanced-v2 weighted sampling. This keeps
    // short-session distributions converging to the configured weights without
    // waiting for a long sticky hit-chain to reach its cap.
    proxyRouteProbeRate: Math.min(1, Math.max(0, parseNumber(env.PROXY_ROUTE_PROBE_RATE, 0.15))),
    proxySessionChannelConcurrencyLimit: Math.max(0, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_CONCURRENCY_LIMIT, 3))),
    proxySessionChannelQueueWaitMs: Math.max(0, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_QUEUE_WAIT_MS, 1_500))),
    proxySessionChannelLeaseTtlMs: Math.max(5_000, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_LEASE_TTL_MS, 90_000))),
    proxySessionChannelLeaseKeepaliveMs: Math.max(1_000, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_LEASE_KEEPALIVE_MS, 15_000))),
    codexUpstreamWebsocketEnabled: parseBoolean(env.CODEX_UPSTREAM_WEBSOCKET_ENABLED, false),
    // Ask OpenAI-compatible upstreams to emit the final usage frame on streams
    // (stream_options.include_usage). On by default; runtime-toggleable via settings.
    streamIncludeUsageEnabled: parseBoolean(env.STREAM_INCLUDE_USAGE_ENABLED, true),
    // Context-aware routing: exclude candidate sites whose KNOWN effective
    // context window cannot fit the request (input estimate + output budget,
    // learned per site×model from upstream errors/metadata/manual pins).
    // 'off' disables filtering and failover-on-overflow; 'exclude_known' only
    // filters sites with a confirmed limit below the requirement; 'strict'
    // additionally requires every candidate to be known-sufficient.
    // Runtime-toggleable via settings (context_aware_routing).
    contextAwareRouting: parseContextAwareRoutingMode(env.CONTEXT_AWARE_ROUTING),
    contextRoutingMarginPct: Math.max(0, Math.min(50, parseNumber(env.CONTEXT_ROUTING_MARGIN_PCT, 5))),
    contextRoutingDefaultOutputTokens: Math.max(0, Math.trunc(parseNumber(env.CONTEXT_ROUTING_DEFAULT_OUTPUT_TOKENS, 8192))),
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
    // Timeout shared by the on-demand marketplace probe and post-refresh probes.
    modelAvailabilityProbeTimeoutMs: Math.max(3_000, Math.trunc(parseNumber(env.MODEL_AVAILABILITY_PROBE_TIMEOUT_MS, 30_000))),
    // Channel probe (heartbeat for active channels). Default 30s to match the
    // marketplace probe timeout: free/slow relay sites routinely take >10s to
    // return a first byte, and a too-short heartbeat marks healthy channels as
    // dead, extending their cooldown unnecessarily.
    probeHeartbeatIntervalMs: Math.max(60_000, Math.trunc(parseNumber(env.PROBE_HEARTBEAT_INTERVAL_MS, 2 * 60 * 1000))),
    probeHeartbeatTimeoutMs: Math.max(3_000, Math.trunc(parseNumber(env.PROBE_HEARTBEAT_TIMEOUT_MS, 30_000))),
    probeMaxBatch: Math.max(1, Math.min(4, Math.trunc(parseNumber(env.PROBE_MAX_BATCH, 2)))),
    probeInitialRetriesAfterCooldown: Math.max(1, Math.min(5, Math.trunc(parseNumber(env.PROBE_INITIAL_RETRIES_AFTER_COOLDOWN, 2)))),
    proxyLogRetentionDays: Math.max(0, Math.trunc(parseNumber(env.PROXY_LOG_RETENTION_DAYS, 30))),
    proxyLogRetentionPruneIntervalMinutes: Math.max(1, Math.trunc(parseNumber(env.PROXY_LOG_RETENTION_PRUNE_INTERVAL_MINUTES, 30))),
    proxyFileRetentionDays: Math.max(0, Math.trunc(parseNumber(env.PROXY_FILE_RETENTION_DAYS, 30))),
    proxyFileRetentionPruneIntervalMinutes: Math.max(1, Math.trunc(parseNumber(env.PROXY_FILE_RETENTION_PRUNE_INTERVAL_MINUTES, 60))),
    proxyErrorKeywords: parseCsvList(env.PROXY_ERROR_KEYWORDS),
    // Explicit CORS origin allowlist. Empty means the server keeps its
    // permissive default (reflecting the request Origin) so existing
    // deployments are unaffected until an operator sets CORS_ORIGINS.
    corsOrigins: parseCsvList(env.CORS_ORIGINS),
    proxyEmptyContentFailEnabled: parseBoolean(env.PROXY_EMPTY_CONTENT_FAIL, false),
    codexResponsesWebsocketBeta: parseOptionalSecret(env.CODEX_RESPONSES_WEBSOCKET_BETA) || 'responses_websockets=2026-02-06',
    codexHeaderDefaults: {
      userAgent: parseOptionalSecret(env.CODEX_HEADER_DEFAULTS_USER_AGENT),
      betaFeatures: parseOptionalSecret(env.CODEX_HEADER_DEFAULTS_BETA_FEATURES),
    },
    payloadRules: normalizePayloadRulesConfig(parseJsonValue(env.PAYLOAD_RULES_JSON || env.PAYLOAD_RULES)),
    routingWeights: {
      baseWeightFactor: parseClampedWeight(env.BASE_WEIGHT_FACTOR, 0.5),
      valueScoreFactor: parseClampedWeight(env.VALUE_SCORE_FACTOR, 0.5),
      costWeight: parseClampedWeight(env.COST_WEIGHT, 0.4),
      balanceWeight: parseClampedWeight(env.BALANCE_WEIGHT, 0.3),
      usageWeight: parseClampedWeight(env.USAGE_WEIGHT, 0.3),
    },
    defaultRoutingStrategy: normalizeRouteRoutingStrategy(env.ROUTING_STRATEGY),
  };
}

export const config = buildConfig(process.env);

/**
 * Probe timeouts track the proxy's first-byte window unless an operator pinned
 * them with an explicit env value.
 *
 * A probe that gives up sooner than real traffic would marks slow-but-healthy
 * relays dead, and their cooldown then keeps the channel out of routing even
 * though a real request would have succeeded; a probe that waits longer only
 * spends its own budget. Reading `proxyFirstByteTimeoutSec` per call (rather
 * than at boot) matters because the settings API mutates it at runtime.
 */
function resolveProbeTimeoutMs(explicitEnvValue: string | undefined, fallbackMs: number): number {
  const explicit = parseNumber(explicitEnvValue, NaN);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(3_000, Math.trunc(explicit));
  const firstByteMs = Math.trunc(Math.max(0, config.proxyFirstByteTimeoutSec || 0) * 1000);
  return Math.max(3_000, firstByteMs || fallbackMs);
}

/** Model-availability probe budget (see resolveProbeTimeoutMs). */
export function resolveModelAvailabilityProbeTimeoutMs(): number {
  return resolveProbeTimeoutMs(process.env.MODEL_AVAILABILITY_PROBE_TIMEOUT_MS, 30_000);
}

/** Channel heartbeat/recovery probe budget (see resolveProbeTimeoutMs). */
export function resolveProbeHeartbeatTimeoutMs(): number {
  return resolveProbeTimeoutMs(process.env.PROBE_HEARTBEAT_TIMEOUT_MS, 30_000);
}

/**
 * Inter-chunk idle budget for an in-flight upstream stream.
 *
 * The first-byte window only covers the wait for the first chunk; this is the
 * budget for silence *between* chunks, so an upstream that emits one chunk and
 * then stops ends the request instead of holding it until the client gives up.
 * Follows `proxyFirstByteTimeoutSec` — the same knob the probe budgets follow,
 * editable in the UI — instead of introducing a second timeout setting: one
 * value answers "how long may an upstream stay silent". `proxyFirstByteTimeoutSec
 * <= 0` returns 0 (no deadline) rather than inventing a budget the operator
 * explicitly turned off.
 */
export function resolveProxyStreamIdleTimeoutMs(): number {
  const firstByteMs = Math.trunc(Math.max(0, config.proxyFirstByteTimeoutSec || 0) * 1000);
  return firstByteMs > 0 ? firstByteMs : 0;
}

export function buildFastifyOptions(
  appConfig: ReturnType<typeof buildConfig>,
): FastifyServerOptions {
  return {
    logger: true,
    // false | true | hop count — avoid unconditionally trusting client-supplied XFF.
    // Default preserves legacy trust-all (true); TRUST_PROXY=false disables; TRUST_PROXY_HOPS=N constrains.
    //
    // fastify >= 5.12 no longer accepts a bare number here: it types `trustProxy`
    // as boolean | string | string[] | function and compiles a numeric value to
    // "trust nothing" (GHSA-3m5p-2c4r-xxw2 — hop-count-only trust cannot validate
    // the immediate peer, so a direct client could inject X-Forwarded-For and
    // choose its own address). Passing the number through would therefore silently
    // collapse every client to the proxy address and break IP allowlists, so the
    // hop window is expressed explicitly instead, keeping the configured meaning.
    // Note the residual caveat that motivated the upstream change: hop-count trust
    // is only as strong as the assumption that nothing else can reach this port.
    // Where the proxy addresses are known, prefer an explicit list over hops.
    trustProxy: appConfig.trustProxy
      ? (appConfig.trustProxyHops != null
        ? (_address: string, hop: number) => hop < (appConfig.trustProxyHops as number)
        : true)
      : false,
    bodyLimit: appConfig.requestBodyLimit,
  };
}

export function isInsecureDefaultSecret(value: string | null | undefined): boolean {
  const normalized = (value || '').trim();
  return (
    normalized.length === 0
    || normalized === INSECURE_DEFAULT_AUTH_TOKEN
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
    'Fix: set strong AUTH_TOKEN + ACCOUNT_CREDENTIAL_SECRET in env; downstream clients use UI-generated keys.',
    'Emergency only: ALLOW_INSECURE_DEFAULTS=true',
  ].join('\n');
  throw new Error(message);
}
