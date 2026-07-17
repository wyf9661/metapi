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

export function logRouteSelection(input: RouteSelectionLogInput): void {
  try {
    console.info(formatRouteSelectionLogLine(input));
  } catch {
    // never break proxy path on logging
  }
}
