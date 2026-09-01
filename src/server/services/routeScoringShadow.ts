/**
 * Balanced-v2 route scoring (live selection for weighted strategy).
 *
 * Prefers direct API-key (shared) accounts over paid session accounts that are
 * truly low on balance, and soft-demotes channels whose account/model connectivity
 * was recently proven false by probe or live proxy traffic.
 */

import { clampNumber } from './tokenRouterMath.js';
import {
  CONNECTIVITY_FACTOR_NULL,
  type ConnectivitySignal,
  connectivityScoreFactor,
} from './routeConnectivityLookup.js';

export type ShadowCostSource = 'observed' | 'configured' | 'catalog' | 'fallback' | 'unknown';

export type ShadowCandidateInput = {
  channelId: number;
  siteId: number;
  siteName?: string | null;
  accountId: number;
  accountUsername?: string | null;
  /** Balance value only when it was successfully fetched from upstream. */
  balance: number | null;
  /** False for direct API-key sites whose schema default balance=0 is not real quota. */
  balanceKnown: boolean;
  /** direct API key vs session cookie account. */
  credentialKind: 'apikey' | 'session' | 'unknown';
  channelWeight: number;
  successCount: number;
  failCount: number;
  unitCost: number;
  costSource: ShadowCostSource;
  /** Runtime health multiplier in (0, 1], 1 = healthy. */
  runtimeHealth: number;
  /** Historical site health multiplier in (0, 1]. */
  historicalHealth: number;
  /** Recent success rate 0..1 if known. */
  recentSuccessRate: number | null;
  recentSampleCount: number;
  /** Load multiplier already computed by coordinator (0.18..1). */
  loadMultiplier: number;
  manualSiteWeight?: number;
  /**
   * Marketplace/live connectivity for account+model:
   * null untested, true proven, false recently failed.
   */
  connectivity?: ConnectivitySignal;
  /** Soft multiplier from site protocol profile (Codex/responses). */
  protocolAffinity?: number;
  /**
   * Time-to-first-token EWMA (ms) from live proxy samples, keyed by
   * routeId+siteId+model+stream. null = no sample yet (neutral).
   * Faster first tokens raise the score; slower ones lower it.
   */
  ttftEwmaMs?: number | null;
};

export type ShadowScoreFactors = {
  manualWeight: number;
  health: number;
  reliability: number;
  cost: number;
  balance: number;
  /** Explicit direct API-key priority (shared/public keys should be consumed first). */
  credential: number;
  load: number;
  /** Soft multiplier from connectivity (true > null > false). */
  connectivity: number;
  /** Soft multiplier from site protocol profile. */
  protocolAffinity: number;
  /** Time-to-first-token factor (faster = higher, neutral 1 when unknown). */
  ttft: number;
  /** Bounded minimum probability floor after normalization. */
  minShare: number;
  exclusion: string | null;
};

export type ShadowScoredCandidate = {
  channelId: number;
  siteId: number;
  siteName: string | null;
  accountId: number;
  accountUsername: string | null;
  score: number;
  probability: number;
  factors: ShadowScoreFactors;
  expectedRequestCost: number;
  balanceCoverage: number | null;
};

export type ShadowSelectionResult = {
  selectedChannelId: number | null;
  candidates: ShadowScoredCandidate[];
  excluded: Array<{ channelId: number; reason: string }>;
};

/** Prior for Bayesian success smoothing: ~95% prior with strength 20. */
const PRIOR_SUCCESS = 19;
const PRIOR_TOTAL = 20;

/** Target number of requests balance should cover for full score. */
const TARGET_BALANCE_COVERAGE = 100;

/** Minimum expected request cost to avoid divide-by-zero / infinite coverage. */
const MIN_REQUEST_COST = 1e-6;

export function resolveExpectedRequestCost(unitCost: number, costSource: ShadowCostSource): number {
  const cost = Number.isFinite(unitCost) && unitCost > 0 ? unitCost : 1;
  // observed/configured/catalog are treated as per-request effective cost already
  // (tokenRouter stores totalCost/successCount as unitCost).
  if (costSource === 'fallback' || costSource === 'unknown') {
    return Math.max(MIN_REQUEST_COST, cost);
  }
  return Math.max(MIN_REQUEST_COST, cost);
}

export function computeBalanceCoverage(balance: number | null, expectedRequestCost: number): number | null {
  if (balance == null || !Number.isFinite(balance)) return null;
  if (balance <= 0) return 0;
  return balance / Math.max(MIN_REQUEST_COST, expectedRequestCost);
}

export function computeBalanceFactor(coverage: number | null): { factor: number; exclusion: string | null } {
  if (coverage == null) {
    // Unknown (direct API-key/free/unread) is neutral. DB default 0 must not mean exhausted.
    return { factor: 0.85, exclusion: null };
  }
  // Hard exclusion: balance known but insufficient for even a single request.
  if (coverage <= 1) return { factor: 0, exclusion: '余额不足' };
  // Low balance: strongly penalize but still eligible.
  if (coverage < 5) return { factor: 0.05, exclusion: null };
  if (coverage < 20) return { factor: 0.20, exclusion: null };
  const factor = clampNumber(
    Math.log1p(coverage) / Math.log1p(TARGET_BALANCE_COVERAGE),
    0.35,
    1,
  );
  return { factor, exclusion: null };
}

export function computeReliabilityFactor(
  successCount: number,
  failCount: number,
  recentSuccessRate: number | null,
  recentSampleCount: number,
): number {
  const total = Math.max(0, successCount) + Math.max(0, failCount);
  const smoothed = (Math.max(0, successCount) + PRIOR_SUCCESS) / (total + PRIOR_TOTAL);
  let reliability = smoothed;
  if (recentSuccessRate != null && Number.isFinite(recentSuccessRate) && recentSampleCount > 0) {
    const conf = clampNumber(recentSampleCount / 8, 0, 1);
    reliability = reliability * (1 - conf) + clampNumber(recentSuccessRate, 0, 1) * conf;
  }
  // Cubic penalty on low reliability.
  return clampNumber(reliability ** 3, 0.02, 1);
}

export function computeCostFactor(unitCost: number, costSource: ShadowCostSource, peerCosts: number[]): number {
  if (costSource === 'fallback' || costSource === 'unknown') {
    return 0.75;
  }
  const cost = Math.max(MIN_REQUEST_COST, unitCost);
  const peers = peerCosts.filter((c) => Number.isFinite(c) && c > 0);
  if (peers.length === 0) return 1;
  const minCost = Math.min(...peers);
  // Cheaper is better: minCost/cost in (0, 1]
  return clampNumber(minCost / cost, 0.15, 1.25);
}

/** TTFT baseline: first tokens faster than this get a boost, slower get a penalty. */
const TTFT_BASELINE_MS = 2_000;
/** How far a TTFT difference can push the score (0.6x .. 1.35x). */
const TTFT_MAX_FACTOR = 1.35;
const TTFT_MIN_FACTOR = 0.6;

/**
 * Bounded minimum probability floor for every healthy candidate. With N active
 * candidates each keeps at least clamp(1/N, MIN..MAX) of the traffic share so
 * new/small sites are actually tried, decaying as reliability is proven.
 */
const MIN_PROBABILITY_FLOOR = 0.03;
const MAX_PROBABILITY_FLOOR = 0.15;
/** Default floor when the caller does not pass a configured value. */
const DEFAULT_PROBABILITY_FLOOR = 0.05;

/**
 * Time-to-first-token factor. No sample = neutral 1. Faster first tokens
 * (streaming) raise the score; slow ones lower it. Clamped so a single slow
 * site cannot be crushed and a fast site cannot dominate purely on latency.
 */
export function computeTtftFactor(ttftEwmaMs: number | null | undefined): number {
  if (ttftEwmaMs == null || !Number.isFinite(ttftEwmaMs) || ttftEwmaMs <= 0) return 1;
  const ratio = TTFT_BASELINE_MS / ttftEwmaMs;
  return clampNumber(ratio, TTFT_MIN_FACTOR, TTFT_MAX_FACTOR);
}

export function scoreShadowCandidate(
  input: ShadowCandidateInput,
  peerUnitCosts: number[],
): ShadowScoredCandidate {
  const expectedRequestCost = resolveExpectedRequestCost(input.unitCost, input.costSource);
  // Direct API-key accounts (often shared/public welfare keys) store balance=0 by schema default.
  // They are NOT depleted: prefer them over paid session accounts when healthy.
  let coverage: number | null = null;
  let balance: { factor: number; exclusion: string | null };
  if (input.credentialKind === 'apikey' || !input.balanceKnown) {
    coverage = null;
    // Slight boost for explicit direct API keys (shared/public keys are valuable).
    balance = {
      factor: input.credentialKind === 'apikey' ? 1.15 : 0.9,
      exclusion: null,
    };
  } else {
    coverage = computeBalanceCoverage(input.balance, expectedRequestCost);
    balance = computeBalanceFactor(coverage);
  }

  const manualWeight = Math.max(0.1, (input.channelWeight || 10) / 10)
    * Math.max(0.05, input.manualSiteWeight ?? 1);
  const health = clampNumber(input.runtimeHealth * input.historicalHealth, 0.02, 1);
  const reliability = computeReliabilityFactor(
    input.successCount,
    input.failCount,
    input.recentSuccessRate,
    input.recentSampleCount,
  );
  const cost = computeCostFactor(input.unitCost, input.costSource, peerUnitCosts);
  const load = clampNumber(input.loadMultiplier, 0.18, 1);
  // Direct API-key accounts (shared/public welfare keys) get an explicit boost.
  // Session accounts and unknown credential types stay neutral.
  const credential = input.credentialKind === 'apikey' ? 2.3 : 1.0;
  const connectivity = connectivityScoreFactor(input.connectivity ?? null);
  const protocolAffinity = clampNumber(
    Number.isFinite(input.protocolAffinity) ? Number(input.protocolAffinity) : 1,
    0.5,
    1.5,
  );
  const ttft = computeTtftFactor(input.ttftEwmaMs);

  let exclusion = balance.exclusion;
  let score = 0;
  if (!exclusion) {
    score = manualWeight
      * health
      * (reliability ** 1.5)
      * (cost ** 1.1)
      * (Math.min(balance.factor, 2.0) ** 0.9)
      * credential
      * (load ** 0.8)
      * connectivity
      * protocolAffinity
      * ttft;
    if (!Number.isFinite(score) || score <= 0) {
      score = 0;
      exclusion = exclusion || '评分无效';
    }
  }

  return {
    channelId: input.channelId,
    siteId: input.siteId,
    siteName: input.siteName ?? null,
    accountId: input.accountId,
    accountUsername: input.accountUsername ?? null,
    score,
    probability: 0,
    factors: {
      manualWeight,
      health,
      reliability,
      cost,
      balance: balance.factor,
      credential,
      load,
      connectivity,
      protocolAffinity,
      ttft,
      minShare: 0,
      exclusion,
    },
    expectedRequestCost,
    balanceCoverage: coverage,
  };
}

export function rankShadowCandidates(
  inputs: ShadowCandidateInput[],
  options?: { probabilityFloor?: number },
): ShadowSelectionResult {
  if (inputs.length === 0) {
    return { selectedChannelId: null, candidates: [], excluded: [] };
  }
  const peerCosts = inputs
    .filter((c) => c.costSource !== 'fallback' && c.costSource !== 'unknown')
    .map((c) => c.unitCost)
    .filter((c) => Number.isFinite(c) && c > 0);

  const scored = inputs.map((input) => scoreShadowCandidate(input, peerCosts));
  const active = scored.filter((c) => !c.factors.exclusion && c.score > 0);
  const excluded = scored
    .filter((c) => c.factors.exclusion)
    .map((c) => ({ channelId: c.channelId, reason: c.factors.exclusion as string }));

  // Bounded floor so every healthy candidate gets a real chance, decaying as
  // the candidate proves itself. Without it, score/total normalization lets a
  // dominant site (high credential+reliability) starve new/small sites into a
  // permanent near-zero probability: fewer calls -> fewer samples -> lower
  // score -> even fewer calls.
  const activeCount = active.length;
  const configuredFloor = Number.isFinite(options?.probabilityFloor)
    ? clampNumber(Number(options?.probabilityFloor ?? 0), MIN_PROBABILITY_FLOOR, MAX_PROBABILITY_FLOOR)
    : DEFAULT_PROBABILITY_FLOOR;
  const minShare = activeCount > 0
    ? clampNumber(Math.max(1 / activeCount, configuredFloor), MIN_PROBABILITY_FLOOR, MAX_PROBABILITY_FLOOR)
    : 0;

  const total = active.reduce((sum, c) => sum + c.score, 0);
  const applyFloor = (c: ShadowScoredCandidate): number => {
    if (c.factors.exclusion || total <= 0) return 0;
    const raw = c.score / total;
    if (activeCount <= 1) return 1;
    // Dynamic decay: a candidate with a proven high success rate does not need
    // the floor (its score already wins traffic); a new/struggling one keeps it.
    const successRate = c.factors.reliability;
    const decayedFloor = minShare * (1 - clampNumber(successRate, 0, 1));
    return Math.max(raw, decayedFloor);
  };
  for (const c of scored) {
    c.probability = applyFloor(c);
    c.factors.minShare = minShare;
  }

  // Re-normalize so probabilities sum to 1 after the floor lift.
  const floorTotal = active.reduce((sum, c) => sum + c.probability, 0);
  if (floorTotal > 0) {
    for (const c of scored) {
      c.probability = c.probability / floorTotal;
    }
  }

  active.sort((a, b) => b.score - a.score);
  const selectedChannelId = active[0]?.channelId ?? null;

  // Return all candidates ordered by score desc, excluded at end.
  const ordered = [
    ...active,
    ...scored.filter((c) => c.factors.exclusion).sort((a, b) => a.channelId - b.channelId),
  ];

  return {
    selectedChannelId,
    candidates: ordered,
    excluded,
  };
}

export function formatShadowSelectionLog(input: {
  requestedModel: string;
  liveChannelId: number | null;
  shadow: ShadowSelectionResult;
}): string {
  const top = input.shadow.candidates.filter((c) => !c.factors.exclusion).slice(0, 3);
  const topText = top.map((c, i) => (
    `#${i + 1} ch=${c.channelId} site=${c.siteId}:${c.siteName || ''} p=${(c.probability * 100).toFixed(1)}% `
    + `cred=${c.factors.credential.toFixed(2)} bal=${c.factors.balance.toFixed(2)} cost=${c.factors.cost.toFixed(2)} `
    + `rel=${c.factors.reliability.toFixed(2)} health=${c.factors.health.toFixed(2)} `
    + `conn=${(c.factors.connectivity ?? CONNECTIVITY_FACTOR_NULL).toFixed(2)} `
    + `proto=${(c.factors.protocolAffinity ?? 1).toFixed(2)} `
    + `cov=${c.balanceCoverage == null ? 'na' : c.balanceCoverage.toFixed(1)}`
  )).join(' | ');
  const excludedText = input.shadow.excluded.slice(0, 5).map((e) => `ch=${e.channelId}:${e.reason}`).join(', ');
  const agree = input.liveChannelId != null && input.liveChannelId === input.shadow.selectedChannelId;
  return (
    `[route-shadow] model=${input.requestedModel} live=${input.liveChannelId ?? 'none'} `
    + `shadow=${input.shadow.selectedChannelId ?? 'none'} agree=${agree ? 1 : 0} `
    + `top=[${topText || '—'}] excluded=[${excludedText || '—'}]`
  );
}
