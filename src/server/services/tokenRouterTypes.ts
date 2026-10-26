/**
 * Row/candidate shapes owned by the token router.
 *
 * These used to live inside `tokenRouter.ts`, which made every helper that
 * touches a candidate unextractable: the router's own modules could not name the
 * type without importing the whole router back. They are pure type declarations
 * (no runtime code), so both the router and its helpers can import them freely.
 *
 * Import cycle note: this file imports only the db schema and the shared route
 * contract, both of which are leaves.
 */
import { schema } from '../db/index.js';
import type { RouteDecision, RouteDecisionReasonCode, RouteMode } from '../../shared/tokenRouteContract.js';
import type { DownstreamRoutingPolicy } from './downstreamPolicyTypes.js';
import type { ModelResolution } from './tokenRouterModelMatching.js';

export interface RouteMatch {
  route: RouteRow;
  channels: Array<{
    channel: typeof schema.routeChannels.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    site: typeof schema.sites.$inferSelect;
    token: typeof schema.accountTokens.$inferSelect | null;
  }>;
}

export type RouteChannelCandidate = RouteMatch['channels'][number];

export type RouteRow = typeof schema.tokenRoutes.$inferSelect & {
  routeMode: RouteMode;
  sourceRouteIds: number[];
};
export type ChannelRow = typeof schema.routeChannels.$inferSelect;

/* ------------------------------------------------------------------------- *
 * Selection-shape types.
 *
 * They used to live in `tokenRouter.ts`, which made the selection engine
 * import the router back for the sole purpose of naming its own arguments —
 * a type-level cycle around a module that the router also imports at runtime.
 * They are pure declarations, so they belong here with the candidate shapes.
 * ------------------------------------------------------------------------- */

export type WeightedSelectionMode = 'weighted' | 'stable_first';

export type WeightedSelectionResult = {
  selected: RouteChannelCandidate | null;
  details: Array<{ candidate: RouteChannelCandidate; probability: number; reason: string }>;
  stableSiteCount: number;
};

export type RouteDecisionExplanation = RouteDecision & {
  routeId?: number;
  modelPattern?: string;
  selectedAccountId?: number;
  modelResolution?: ModelResolution;
};

export type ExplainSelectionOptions = {
  excludeChannelIds?: number[];
  bypassSourceModelCheck?: boolean;
  useChannelSourceModelForCost?: boolean;
  downstreamPolicy?: DownstreamRoutingPolicy;
  /** Request's estimated context requirement — mirrors the live selection
   * filter so the decision snapshot and the real choice agree. */
  requiredContextTokens?: number;
};

export type CandidateEligibilityReason = {
  code: RouteDecisionReasonCode;
  message: string;
  details?: Record<string, unknown>;
};

export type CandidateEligibilityOptions = {
  requestedModel: string;
  bypassSourceModelCheck?: boolean;
  excludeChannelIds?: number[];
  nowIso?: string;
  downstreamPolicy?: DownstreamRoutingPolicy;
  /** Request's estimated context requirement (input + output budget + margin). */
  requiredContextTokens?: number;
  /** Availability-first: relax a cooldown that came from a HEALTH PROBE when it
   * would be the only reason the candidate set is empty. Real-failure and
   * credential-scoped cooldowns stay hard exclusions (see
   * isProbeAttributableCooldown). */
  ignoreProbeCooldown?: boolean;
  /** Availability-first: relax a real-failure cooldown when it is the ONLY
   * reason the candidate pool is empty. A cooldown is a prediction, not a
   * verdict; with a single-channel route it would otherwise turn one slow
   * answer into guaranteed downtime for the whole route. */
  ignoreChannelCooldown?: boolean;
};
