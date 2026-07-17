export type RouteSelectionLogInput = {
  requestedModel: string;
  selected: {
    channel: { id: number; routeId?: number | null; sourceModel?: string | null };
    site: { id: number; name?: string | null; platform?: string | null };
    account: { id: number; username?: string | null };
    actualModel?: string | null;
  } | null;
  retryCount?: number;
  sticky?: boolean;
  forcedChannelId?: number | null;
  reason?: string | null;
};

export type RouteSelectionAuditEntry = {
  at: string;
  requestedModel: string;
  routeId: number | null;
  channelId: number | null;
  siteId: number | null;
  siteName: string | null;
  platform: string | null;
  accountId: number | null;
  sourceModel: string | null;
  actualModel: string | null;
  retryCount: number;
  sticky: boolean;
  forcedChannelId: number | null;
  reason: string;
};

const RECENT_SELECTION_LIMIT = 50;
const recentSelections: RouteSelectionAuditEntry[] = [];

/**
 * Compact one-line selection audit for operators.
 * Keep stable field order for log grepping: route/channel/site/sourceModel/reason.
 */
export function formatRouteSelectionLogLine(input: RouteSelectionLogInput): string {
  const selected = input.selected;
  if (!selected) {
    return `[route-select] model=${input.requestedModel} selected=none retry=${input.retryCount ?? 0}`;
  }
  const parts = [
    `model=${input.requestedModel}`,
    `route=${selected.channel.routeId ?? '-'}`,
    `channel=${selected.channel.id}`,
    `site=${selected.site.id}:${selected.site.name || ''}`,
    `platform=${selected.site.platform || ''}`,
    `account=${selected.account.id}`,
    `sourceModel=${selected.channel.sourceModel || selected.actualModel || ''}`,
    `actualModel=${selected.actualModel || ''}`,
    `retry=${input.retryCount ?? 0}`,
    `sticky=${input.sticky ? 1 : 0}`,
    `forced=${input.forcedChannelId ?? ''}`,
    `reason=${input.reason || (input.sticky ? 'sticky' : (input.retryCount ? 'failover' : 'primary'))}`,
  ];
  return `[route-select] ${parts.join(' ')}`;
}

function toAuditEntry(input: RouteSelectionLogInput): RouteSelectionAuditEntry {
  const selected = input.selected;
  const reason = input.reason
    || (input.forcedChannelId ? 'forced' : (input.sticky ? 'sticky' : (input.retryCount ? 'failover' : 'primary')));
  return {
    at: new Date().toISOString(),
    requestedModel: input.requestedModel,
    routeId: selected?.channel.routeId ?? null,
    channelId: selected?.channel.id ?? null,
    siteId: selected?.site.id ?? null,
    siteName: selected?.site.name ?? null,
    platform: selected?.site.platform ?? null,
    accountId: selected?.account.id ?? null,
    sourceModel: selected?.channel.sourceModel || selected?.actualModel || null,
    actualModel: selected?.actualModel ?? null,
    retryCount: input.retryCount ?? 0,
    sticky: !!input.sticky,
    forcedChannelId: input.forcedChannelId ?? null,
    reason,
  };
}

export function logRouteSelection(input: RouteSelectionLogInput): void {
  try {
    const entry = toAuditEntry(input);
    recentSelections.unshift(entry);
    if (recentSelections.length > RECENT_SELECTION_LIMIT) {
      recentSelections.length = RECENT_SELECTION_LIMIT;
    }
    console.info(formatRouteSelectionLogLine(input));
  } catch {
    // never break proxy path on logging
  }
}

export function getRecentRouteSelections(limit = 20): RouteSelectionAuditEntry[] {
  const n = Math.max(1, Math.min(RECENT_SELECTION_LIMIT, Math.trunc(limit) || 20));
  return recentSelections.slice(0, n);
}

/** Test-only helper to clear ring buffer between cases. */
export function __resetRecentRouteSelectionsForTests(): void {
  recentSelections.length = 0;
}
