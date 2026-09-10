import type {
  ProxyLogBillingDetails,
  ProxyLogListItem,
  ProxyLogStatusFilter,
  ProxyLogUsageSource,
  RuntimeSettingsPayload,
} from '../../api.js';

export type ProxyLogRenderItem = ProxyLogListItem & {
  billingDetails?: ProxyLogBillingDetails;
  username?: string | null;
  siteName?: string | null;
  siteUrl?: string | null;
  errorMessage?: string | null;
};

export type ProxyDebugSettingsState = {
  proxyDebugTraceEnabled: boolean;
  proxyDebugCaptureHeaders: boolean;
  proxyDebugCaptureBodies: boolean;
  proxyDebugCaptureStreamChunks: boolean;
  proxyDebugTargetSessionId: string;
  proxyDebugTargetClientKind: string;
  proxyDebugTargetModel: string;
  proxyDebugRetentionHours: number;
  proxyDebugMaxBodyBytes: number;
};

export type StoredDebugPreviewPayload = {
  __metapiTruncated?: boolean;
  preview?: string;
  originalBytes?: number;
  storedBytes?: number;
};

export const PAGE_SIZES = [5, 10, 20, 50, 100];
export const DEFAULT_PAGE_SIZE = 50;
export const TRACE_TABLE_LIMIT = 20;
export const DEBUG_TRACE_PAGE_SIZE = 5;
export const PROXY_LOGS_DEBUG_TRACE_PANEL_STORAGE_KEY =
  'metapi.proxyLogs.debugTracePanelExpanded';
export const DEBUG_REFRESH_INTERVAL_MS = 2000;

export const EMPTY_SUMMARY = {
  totalCount: 0,
  successCount: 0,
  failedCount: 0,
  totalCost: 0,
  totalTokensAll: 0,
};

export const DEFAULT_PROXY_DEBUG_SETTINGS: ProxyDebugSettingsState = {
  proxyDebugTraceEnabled: false,
  proxyDebugCaptureHeaders: true,
  proxyDebugCaptureBodies: false,
  proxyDebugCaptureStreamChunks: false,
  proxyDebugTargetSessionId: '',
  proxyDebugTargetClientKind: '',
  proxyDebugTargetModel: '',
  proxyDebugRetentionHours: 24,
  proxyDebugMaxBodyBytes: 262144,
};

export function formatLatency(ms: number) {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
  }
  return `${ms}ms`;
}

export function latencyColor(ms: number) {
  if (ms >= 3000) return 'var(--color-danger)';
  if (ms >= 2000)
    return 'color-mix(in srgb, var(--color-warning) 30%, var(--color-danger))';
  if (ms >= 1500)
    return 'color-mix(in srgb, var(--color-warning) 60%, var(--color-danger))';
  if (ms >= 1000) return 'var(--color-warning)';
  if (ms > 500)
    return 'color-mix(in srgb, var(--color-success) 60%, var(--color-warning))';
  return 'var(--color-success)';
}

export function firstByteColor(ms: number) {
  if (ms >= 3000) return 'var(--color-danger)';
  if (ms >= 1000) return 'var(--color-warning)';
  return 'var(--color-primary)';
}

export function formatTokensPerSecond(tokens: number | null | undefined, latencyMs: number | null | undefined) {
  if (
    tokens == null || !Number.isFinite(tokens) || tokens <= 0 ||
    latencyMs == null || !Number.isFinite(latencyMs) || latencyMs <= 0
  ) {
    return null;
  }
  const tps = tokens / (latencyMs / 1000);
  return `${Math.round(tps)} t/s`;
}

/**
 * Effective input tokens for display. Upstreams differ: OpenAI-style responses
 * report prompt_tokens INCLUDING the cached prefix, while Anthropic-style ones
 * report only the non-cached part and carry the rest in cache_read /
 * cache_creation (observed prompt_tokens=3 with cache_read=50483). Without an
 * explicit include flag on the list row, a cache total larger than the prompt
 * is read as the split form and added back, so the usage log never shows a
 * 3-token input for a 50k-token cached request (2026-09-09).
 */
export function resolveProxyLogInputTokens(log: {
  promptTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
}): number {
  const prompt = typeof log.promptTokens === 'number' && Number.isFinite(log.promptTokens)
    ? log.promptTokens
    : 0;
  const cacheTotal = (typeof log.cacheReadTokens === 'number' && Number.isFinite(log.cacheReadTokens) ? log.cacheReadTokens : 0)
    + (typeof log.cacheCreationTokens === 'number' && Number.isFinite(log.cacheCreationTokens) ? log.cacheCreationTokens : 0);
  if (cacheTotal <= 0) return prompt;
  return cacheTotal > prompt ? prompt + cacheTotal : prompt;
}

export function formatProxyLogTokenPair(
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): string {
  const input = typeof inputTokens === 'number' && Number.isFinite(inputTokens) ? inputTokens : null;
  const output = typeof outputTokens === 'number' && Number.isFinite(outputTokens) ? outputTokens : null;
  // A failed call carries no usage at all: show a plain dash pair rather than
  // `0 / --`, which reads like a real (zero-token) request.
  if ((input == null || input <= 0) && (output == null || output <= 0)) return '- / -';
  return `${input == null ? '-' : formatProxyLogTokenValue(input)} / ${output == null ? '-' : formatProxyLogTokenValue(output)}`;
}

// ---------------------------------------------------------------------------
// Timing column, ported from NewAPI's TimingMetricsCell / StreamTpsCell so the
// usage log reads the same in both dashboards:
//   web/src/features/usage-logs/components/timing-metrics-cell.tsx
//   web/src/features/usage-logs/lib/format.ts (get*Color thresholds)
// ---------------------------------------------------------------------------

export type ProxyLogTimingVariant = 'success' | 'warning' | 'danger';

/** NewAPI getTimeColor: duration based thresholds (seconds). */
export function getProxyLogTimeVariant(seconds: number): ProxyLogTimingVariant {
  if (seconds < 10) return 'success';
  if (seconds < 30) return 'warning';
  return 'danger';
}

/** NewAPI getFirstResponseTimeColor: first-token thresholds (seconds). */
export function getProxyLogFirstTokenVariant(seconds: number): ProxyLogTimingVariant {
  if (seconds < 5) return 'success';
  if (seconds < 10) return 'warning';
  return 'danger';
}

/** NewAPI getThroughputColor: generation speed thresholds. */
export function getProxyLogThroughputVariant(tokensPerSecond: number): ProxyLogTimingVariant {
  if (tokensPerSecond >= 30) return 'success';
  if (tokensPerSecond >= 15) return 'warning';
  return 'danger';
}

/**
 * NewAPI getResponseTimeColor: judge the duration by throughput once there is
 * enough output to measure, otherwise fall back to the plain duration scale.
 */
export function getProxyLogResponseTimeVariant(
  seconds: number,
  completionTokens: number,
): ProxyLogTimingVariant {
  if (completionTokens < 100 || seconds <= 0) return getProxyLogTimeVariant(seconds);
  return getProxyLogThroughputVariant(completionTokens / seconds);
}

/** NewAPI formatUseTime: `0.8s` / `12.3s` under a minute, `1m 5s` past it.
 *  MetAPI records first-byte latency in milliseconds, so sub-second values keep
 *  ms precision instead of collapsing to a useless `0.0s`. */
export function formatProxyLogUseTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

export function proxyLogTimingTextColor(variant: ProxyLogTimingVariant): string {
  if (variant === 'success') return 'var(--color-success)';
  if (variant === 'warning') return 'var(--color-warning)';
  return 'var(--color-danger)';
}

/** Softened fills for the full-height timing bar (NewAPI barColorMap). */
export function proxyLogTimingBarColor(variant: ProxyLogTimingVariant): string {
  if (variant === 'success') return 'color-mix(in srgb, var(--color-success) 90%, transparent)';
  if (variant === 'warning') return 'color-mix(in srgb, var(--color-warning) 80%, transparent)';
  return 'color-mix(in srgb, var(--color-danger) 80%, transparent)';
}

/**
 * Retry column: a plain number whose colour deepens with the retry count.
 * No badge/icon — a chip changes the glyph size and baseline, which knocks the
 * column out of vertical alignment with the rows that have no retries.
 */
export function proxyLogRetryColor(retryCount: number | null | undefined): string {
  const count = typeof retryCount === 'number' && Number.isFinite(retryCount) ? retryCount : 0;
  if (count <= 0) return 'var(--color-text-secondary)';
  if (count === 1) return 'var(--color-warning)';
  if (count === 2) return 'color-mix(in srgb, var(--color-warning) 45%, var(--color-danger))';
  return 'var(--color-danger)';
}

/**
 * Key chip tinting. Two keys must be visibly different, so the palette walks the
 * whole colour wheel in 15° steps and the hash picks both a hue and a lightness
 * bucket — the previous 12-hue palette put neighbouring names (codex/hermes) 10°
 * apart, which read as the same colour.
 *
 * The tint stays muted: a few percent of the hue over the theme's grey chip base,
 * and the hash is stable, so a key keeps its colour across reloads and pages.
 */
const PROXY_LOG_KEY_HUES = Array.from({ length: 24 }, (_, index) => index * 15);
const PROXY_LOG_KEY_LIGHTNESSES = [46, 52, 58];

/** FNV-1a: near-identical names (codex / hermes) land far apart, unlike hash*31. */
function proxyLogKeyHash(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function proxyLogKeyHue(key: string): number {
  return PROXY_LOG_KEY_HUES[proxyLogKeyHash(key) % PROXY_LOG_KEY_HUES.length];
}

/** Chip colours for the key column: the grey chip base plus a visible share of the
 *  hashed hue, mixed with the theme variables so both themes stay readable. */
export function proxyLogKeyChipColors(key: string): { background: string; border: string } {
  const hash = proxyLogKeyHash(key);
  const hue = PROXY_LOG_KEY_HUES[hash % PROXY_LOG_KEY_HUES.length];
  const lightness = PROXY_LOG_KEY_LIGHTNESSES[
    Math.floor(hash / PROXY_LOG_KEY_HUES.length) % PROXY_LOG_KEY_LIGHTNESSES.length
  ];
  return {
    background: `color-mix(in srgb, hsl(${hue} 62% ${lightness}%) 20%, var(--color-bg-subtle))`,
    border: `color-mix(in srgb, hsl(${hue} 58% ${lightness}%) 38%, var(--color-border))`,
  };
}

export function formatStreamModeLabel(isStream: boolean | null | undefined) {
  if (isStream == null) return null;
  return isStream ? '流式' : '非流';
}

export function formatFirstByteLabel(ms: number | null | undefined) {
  if (!Number.isFinite(ms) || typeof ms !== 'number' || ms < 0) return null;
  return `首字 ${formatLatency(ms)}`;
}

export function formatCompactNumber(value: number, digits = 6) {
  if (!Number.isFinite(value)) return '0';
  const formatted = value.toFixed(digits).replace(/\.?0+$/, '');
  return formatted || '0';
}

export function formatPerMillionPrice(value: number) {
  return `$${formatCompactNumber(value)} / 1M tokens`;
}

export function formatBillingDetailSummary(log: ProxyLogRenderItem) {
  const detail = log.billingDetails;
  if (!detail) return null;
  return `模型倍率 ${formatCompactNumber(detail.pricing.modelRatio)}，输出倍率 ${formatCompactNumber(detail.pricing.completionRatio)}，缓存倍率 ${formatCompactNumber(detail.pricing.cacheRatio)}，缓存创建倍率 ${formatCompactNumber(detail.pricing.cacheCreationRatio)}，分组倍率 ${formatCompactNumber(detail.pricing.groupRatio)}`;
}

export function formatProxyLogUsageSource(
  source: ProxyLogUsageSource | undefined,
): string | null {
  if (source === 'upstream') return '上游返回';
  if (source === 'self-log') return '站点日志回填';
  if (source === 'unknown') return '未知';
  return null;
}

export function formatProxyLogTokenValue(
  value: number | null | undefined,
): string {
  return typeof value === 'number' ? value.toLocaleString() : '--';
}

export function renderDownstreamKeySummary(log: ProxyLogRenderItem) {
  const parts = [
    log.downstreamKeyName ? `密钥: ${log.downstreamKeyName}` : null,
    log.downstreamKeyGroupName ? `主分组: ${log.downstreamKeyGroupName}` : null,
    Array.isArray(log.downstreamKeyTags) && log.downstreamKeyTags.length > 0
      ? `标签: ${log.downstreamKeyTags.join(' / ')}`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('，') : null;
}

export function buildBillingProcessLines(log: ProxyLogRenderItem) {
  const detail = log.billingDetails;
  if (!detail) return [];

  const lines = [
    `提示价格：${formatPerMillionPrice(detail.breakdown.inputPerMillion)}`,
    `补全价格：${formatPerMillionPrice(detail.breakdown.outputPerMillion)}`,
  ];

  if (detail.usage.cacheReadTokens > 0) {
    lines.push(
      `缓存价格：${formatPerMillionPrice(detail.breakdown.cacheReadPerMillion)} (缓存倍率: ${formatCompactNumber(detail.pricing.cacheRatio)})`,
    );
  }

  if (detail.usage.cacheCreationTokens > 0) {
    lines.push(
      `缓存创建价格：${formatPerMillionPrice(detail.breakdown.cacheCreationPerMillion)} (缓存创建倍率: ${formatCompactNumber(detail.pricing.cacheCreationRatio)})`,
    );
  }

  const parts = [
    `提示 ${detail.usage.billablePromptTokens.toLocaleString()} tokens / 1M tokens * $${formatCompactNumber(detail.breakdown.inputPerMillion)}`,
  ];

  if (detail.usage.cacheReadTokens > 0) {
    parts.push(
      `缓存 ${detail.usage.cacheReadTokens.toLocaleString()} tokens / 1M tokens * $${formatCompactNumber(detail.breakdown.cacheReadPerMillion)}`,
    );
  }

  if (detail.usage.cacheCreationTokens > 0) {
    parts.push(
      `缓存创建 ${detail.usage.cacheCreationTokens.toLocaleString()} tokens / 1M tokens * $${formatCompactNumber(detail.breakdown.cacheCreationPerMillion)}`,
    );
  }

  parts.push(
    `补全 ${detail.usage.completionTokens.toLocaleString()} tokens / 1M tokens * $${formatCompactNumber(detail.breakdown.outputPerMillion)} = $${detail.breakdown.totalCost.toFixed(6)}`,
  );
  lines.push(parts.join(' + '));

  return lines;
}

function padDateTimeSegment(value: number) {
  return String(value).padStart(2, '0');
}

export function formatDateTimeInputValue(value: Date) {
  return `${value.getFullYear()}-${padDateTimeSegment(value.getMonth() + 1)}-${padDateTimeSegment(value.getDate())}T${padDateTimeSegment(value.getHours())}:${padDateTimeSegment(value.getMinutes())}`;
}

export function normalizeRoutePage(raw: string | null): number {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

export function normalizeRoutePageSize(
  raw: string | null,
  fallback: number = DEFAULT_PAGE_SIZE,
): number {
  const parsed = Number.parseInt(raw || '', 10);
  if (PAGE_SIZES.includes(parsed)) return parsed;
  return PAGE_SIZES.includes(fallback) ? fallback : DEFAULT_PAGE_SIZE;
}

export function normalizeRouteStatus(raw: string | null): ProxyLogStatusFilter {
  if (raw === 'success' || raw === 'failed') return raw;
  return 'all';
}

export function normalizeRouteSearch(raw: string | null): string {
  return (raw || '').trim();
}


export function normalizeRouteSiteId(raw: string | null): number | null {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function normalizeRouteDateTimeInput(raw: string | null): string {
  const text = (raw || '').trim();
  if (!text) return '';
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  return formatDateTimeInputValue(parsed);
}

function normalizeRouteModel(raw: string | null): string {
  if (!raw) return '';
  return raw.trim();
}

export function readProxyLogsRouteState(
  search: string,
  pageSizeFallback?: number,
) {
  const params = new URLSearchParams(search);
  return {
    page: normalizeRoutePage(params.get('page')),
    pageSize: normalizeRoutePageSize(params.get('pageSize'), pageSizeFallback),
    status: normalizeRouteStatus(params.get('status')),
    search: normalizeRouteSearch(params.get('q')),
    downstreamKeyId: normalizeRouteSiteId(params.get('downstreamKeyId')),
    siteId: normalizeRouteSiteId(params.get('siteId')),
    model: normalizeRouteModel(params.get('model')),
    from: normalizeRouteDateTimeInput(params.get('from')),
    to: normalizeRouteDateTimeInput(params.get('to')),
  };
}

export function buildProxyLogsRouteSearch(input: {
  page: number;
  pageSize: number;
  status: ProxyLogStatusFilter;
  search: string;
  downstreamKeyId: number | null;
  siteId: number | null;
  model: string;
  from: string;
  to: string;
  /** Page size that is implied by the user's stored preference and therefore
   * omitted from the URL. Defaults to DEFAULT_PAGE_SIZE. */
  pageSizeDefault?: number;
}) {
  const params = new URLSearchParams();
  if (input.page > 1) params.set('page', String(input.page));
  if (input.pageSize !== (input.pageSizeDefault ?? DEFAULT_PAGE_SIZE))
    params.set('pageSize', String(input.pageSize));
  if (input.status !== 'all') params.set('status', input.status);
  if (input.search.trim()) params.set('q', input.search.trim());
  if (input.downstreamKeyId) params.set('downstreamKeyId', String(input.downstreamKeyId));
  if (input.siteId) params.set('siteId', String(input.siteId));
  if (input.model.trim()) params.set('model', input.model.trim());
  if (input.from.trim()) params.set('from', input.from.trim());
  if (input.to.trim()) params.set('to', input.to.trim());
  const next = params.toString();
  return next ? `?${next}` : '';
}

const PROXY_LOG_CLIENT_FAMILY_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude_code: 'Claude Code',
  gemini_cli: 'Gemini CLI',
  generic: '通用',
};

export function formatProxyLogClientFamilyLabel(
  clientFamily?: string | null,
  options?: { includeGeneric?: boolean },
) {
  const normalized =
    typeof clientFamily === 'string' ? clientFamily.trim().toLowerCase() : '';
  if (!normalized) return null;
  if (!options?.includeGeneric && normalized === 'generic') return null;
  return PROXY_LOG_CLIENT_FAMILY_LABELS[normalized] || clientFamily || null;
}

/**
 * The client is often just the downstream User-Agent (the fallback detection
 * stores it verbatim), which can run to 80+ characters. Keep the cell readable
 * and expose the full value as a tooltip.
 */
export function truncateProxyLogClientName(value: string, maxLength = 44): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

export function resolveProxyLogClientDisplay(
  log: Pick<
    ProxyLogRenderItem,
    'clientFamily' | 'clientAppName' | 'clientConfidence'
  >,
  options?: { includeGeneric?: boolean },
) {
  const familyLabel = formatProxyLogClientFamilyLabel(
    log.clientFamily,
    options,
  );
  const appName =
    typeof log.clientAppName === 'string' ? log.clientAppName.trim() : '';
  if (appName) {
    const normalizedFamily = typeof log.clientFamily === 'string'
      ? log.clientFamily.trim().toLowerCase()
      : '';
    return {
      primary: truncateProxyLogClientName(appName),
      // A recognised client app already says more than the "generic" family
      // bucket, so don't repeat it underneath.
      secondary: familyLabel && normalizedFamily !== 'generic' ? familyLabel : null,
      fullName: appName,
      heuristic: log.clientConfidence === 'heuristic',
    };
  }
  return {
    primary: familyLabel,
    secondary: null,
    fullName: null,
    heuristic: false,
  };
}

export function toApiTimeBoundary(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export function normalizeProxyDebugSettings(value: any): ProxyDebugSettingsState {
  return {
    proxyDebugTraceEnabled: !!value?.proxyDebugTraceEnabled,
    proxyDebugCaptureHeaders: value?.proxyDebugCaptureHeaders !== false,
    proxyDebugCaptureBodies: !!value?.proxyDebugCaptureBodies,
    proxyDebugCaptureStreamChunks: !!value?.proxyDebugCaptureStreamChunks,
    proxyDebugTargetSessionId: String(value?.proxyDebugTargetSessionId || ''),
    proxyDebugTargetClientKind: String(value?.proxyDebugTargetClientKind || ''),
    proxyDebugTargetModel: String(value?.proxyDebugTargetModel || ''),
    proxyDebugRetentionHours: Number(value?.proxyDebugRetentionHours || 24),
    proxyDebugMaxBodyBytes: Number(value?.proxyDebugMaxBodyBytes || 262144),
  };
}

export function buildProxyDebugSettingsPayload(
  settings: ProxyDebugSettingsState,
): RuntimeSettingsPayload {
  return {
    proxyDebugTraceEnabled: settings.proxyDebugTraceEnabled,
    proxyDebugCaptureHeaders: settings.proxyDebugCaptureHeaders,
    proxyDebugCaptureBodies: settings.proxyDebugCaptureBodies,
    proxyDebugCaptureStreamChunks: settings.proxyDebugCaptureStreamChunks,
    proxyDebugTargetSessionId: settings.proxyDebugTargetSessionId.trim(),
    proxyDebugTargetClientKind: settings.proxyDebugTargetClientKind.trim(),
    proxyDebugTargetModel: settings.proxyDebugTargetModel.trim(),
    proxyDebugRetentionHours: Math.max(
      1,
      Math.trunc(Number(settings.proxyDebugRetentionHours || 24)),
    ),
    proxyDebugMaxBodyBytes: Math.max(
      1024,
      Math.trunc(Number(settings.proxyDebugMaxBodyBytes || 262144)),
    ),
  };
}

export function formatProxyDebugCaptureSummary(settings: ProxyDebugSettingsState) {
  const parts = ['路由决策'];
  if (settings.proxyDebugCaptureHeaders) parts.push('请求/响应头');
  if (settings.proxyDebugCaptureBodies) parts.push('请求/响应体');
  if (settings.proxyDebugCaptureStreamChunks) parts.push('流式分片');
  return parts.join('、');
}

export function formatProxyDebugTargetSummary(settings: ProxyDebugSettingsState) {
  const parts = [
    settings.proxyDebugTargetSessionId
      ? `Session ${settings.proxyDebugTargetSessionId}`
      : null,
    settings.proxyDebugTargetClientKind
      ? `客户端 ${settings.proxyDebugTargetClientKind}`
      : null,
    settings.proxyDebugTargetModel
      ? `模型 ${settings.proxyDebugTargetModel}`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('，') : '不过滤，记录所有命中的新请求';
}

export function stringifyStoredDebugValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseStoredDebugPreview(value: unknown): {
  raw: string | null;
  displayText: string;
  truncated: boolean;
  note: string | null;
} {
  const raw = stringifyStoredDebugValue(value);
  if (!raw) {
    return {
      raw: null,
      displayText: '-',
      truncated: false,
      note: null,
    };
  }

  try {
    const parsed = JSON.parse(raw) as StoredDebugPreviewPayload | string;
    if (typeof parsed === 'string') {
      return {
        raw,
        displayText: parsed || '-',
        truncated: false,
        note: null,
      };
    }

    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.__metapiTruncated &&
      typeof parsed.preview === 'string'
    ) {
      const originalBytes = Number(parsed.originalBytes || 0);
      const storedBytes = Number(parsed.storedBytes || 0);
      return {
        raw,
        displayText: parsed.preview || '-',
        truncated: true,
        note:
          originalBytes > 0 && storedBytes > 0
            ? `内容已截断展示，原始 ${originalBytes} bytes，当前保留 ${storedBytes} bytes。复制按钮会复制当前数据库里保存的内容。`
            : '内容已截断展示。复制按钮会复制当前数据库里保存的内容。',
      };
    }
  } catch {
    // Fall through to display the saved raw value directly.
  }

  return {
    raw,
    displayText: raw,
    truncated: false,
    note: null,
  };
}

export function readStoredDebugTracePanelExpanded(): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(
      PROXY_LOGS_DEBUG_TRACE_PANEL_STORAGE_KEY,
    );
    if (stored == null) return true;
    return stored !== 'false';
  } catch {
    return true;
  }
}

export function persistDebugTracePanelExpanded(expanded: boolean) {
  try {
    globalThis.localStorage?.setItem(
      PROXY_LOGS_DEBUG_TRACE_PANEL_STORAGE_KEY,
      expanded ? 'true' : 'false',
    );
  } catch {
    // Ignore storage write failures and keep UI responsive.
  }
}
