/**
 * Pure candidate-level helpers for the token router.
 *
 * Third slice of the `tokenRouter.ts` split: recording why a candidate was chosen
 * or rejected, classifying it (OAuth route unit vs. explicit-token channel,
 * cooling-down unit member), and scoring/rendering the runtime load of its
 * channel. Every function here takes a candidate or a load snapshot and returns a
 * value; none of them touch router state.
 */
import { config } from '../config.js';
import type { RouteDecisionCandidate, RouteDecisionReasonCode } from '../../shared/tokenRouteContract.js';
import type { RouteChannelCandidate, RouteRow } from './tokenRouterTypes.js';
import type { RouteRoutingStrategy } from './routeRoutingStrategy.js';
import type { ProxyChannelLoadSnapshot } from './proxyChannelCoordinator.js';
import { clampNumber } from './tokenRouterMath.js';

export function setCandidateDecisionReason(
  candidate: RouteDecisionCandidate,
  code: RouteDecisionReasonCode,
  reason: string,
  details?: Record<string, unknown>,
): void {
  candidate.reason = reason;
  candidate.reasonCodes = [code];
  candidate.reasonDetails = details;
}

export function resolveRouteStrategy(_route: RouteRow): RouteRoutingStrategy {
  return config.defaultRoutingStrategy;
}

export function resolveChannelRuntimeLoadMultiplier(snapshot: ProxyChannelLoadSnapshot): number {
  if (!snapshot.sessionScoped || snapshot.concurrencyLimit <= 0) return 1;

  const activeRatio = clampNumber(snapshot.activeLeaseCount / Math.max(1, snapshot.concurrencyLimit), 0, 1.5);
  const waitingRatio = clampNumber(snapshot.waitingCount / Math.max(1, snapshot.concurrencyLimit), 0, 3);
  const activePenalty = activeRatio * 0.28;
  const waitingPenalty = waitingRatio * 0.32;
  const saturationPenalty = snapshot.saturated ? 0.12 : 0;
  return clampNumber(1 - activePenalty - waitingPenalty - saturationPenalty, 0.18, 1);
}

export function formatChannelRuntimeLoad(snapshot: ProxyChannelLoadSnapshot): string {
  if (!snapshot.sessionScoped || snapshot.concurrencyLimit <= 0) {
    return '未限流';
  }
  const multiplier = resolveChannelRuntimeLoadMultiplier(snapshot);
  return `${multiplier.toFixed(2)}（活跃=${snapshot.activeLeaseCount}/${snapshot.concurrencyLimit}，等待=${snapshot.waitingCount}）`;
}

export function isExplicitTokenChannel(candidate: RouteChannelCandidate): boolean {
  return typeof candidate.channel.tokenId === 'number' && candidate.channel.tokenId > 0;
}
