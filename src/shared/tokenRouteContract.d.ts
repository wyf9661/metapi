export declare const ROUTE_DECISION_REFRESH_TASK_TYPE = 'route-decision.refresh';
export type RouteMode = 'pattern' | 'explicit_group';
export type RouteDecisionReasonCode =
    | 'eligible'
    | 'source_model_mismatch'
    | 'channel_disabled'
    | 'route_unit_unavailable'
    | 'account_unavailable'
    | 'site_disabled'
    | 'downstream_excluded'
    | 'already_attempted'
    | 'token_unavailable'
    | 'channel_cooldown'
    | 'connectivity_avoided'
    | 'runtime_health_avoided'
    | 'recent_failure_avoided'
    | 'round_robin_selected'
    | 'round_robin_waiting'
    | 'stable_first_scored'
    | 'weighted_scored';
export type RouteDecisionCandidate = {
    channelId: number;
    accountId: number;
    username: string;
    siteId: number;
    siteName: string;
    tokenName: string;
    priority: number;
    weight: number;
    eligible: boolean;
    recentlyFailed: boolean;
    avoidedByRecentFailure: boolean;
    probability: number;
    reason: string;
    reasonCodes?: RouteDecisionReasonCode[];
    reasonDetails?: Record<string, unknown>;
};
export type RouteDecision = {
    requestedModel: string;
    actualModel: string;
    matched: boolean;
    selectedChannelId?: number;
    selectedLabel?: string;
    summary: string[];
    candidates: RouteDecisionCandidate[];
};
export declare function normalizeTokenRouteMode(routeMode: unknown): RouteMode;
