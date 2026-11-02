export type PerformanceShadowKey = {
  routeId?: number | null;
  siteId: number;
  modelName: string;
  isStream: boolean;
};

export type PerformanceShadowMetrics = {
  key: string;
  routeId: number | null;
  siteId: number;
  modelName: string;
  isStream: boolean;
  ttftEwmaMs: number | null;
  tpsEwma: number | null;
  e2eLatencyEwmaMs: number | null;
  sampleCount: number;
  updatedAtMs: number;
};

const DEFAULT_ALPHA = 0.3;
const MIN_TPS_COMPLETION_TOKENS = 2;
const PERFORMANCE_SHADOW_TTL_MS = 72 * 60 * 60 * 1000;
const PERFORMANCE_SHADOW_MAX_ENTRIES = 5_000;
const metricsByKey = new Map<string, PerformanceShadowMetrics>();

/**
 * Raw attempt history per key. The EWMA above is a single number and cannot
 * describe a relay that fans out to several internal upstreams (one key, many
 * backends): its first-byte distribution is a mixture with two or three modes
 * and a gap between them, so any mean lands in the gap and fits nothing.
 *
 * These attempts keep enough shape to build the survival curve
 * `S(t) = P(first byte within t)`, including CENSORED attempts: a timeout at
 * window W tells us `T >= W`, which is exactly what the curve needs. Waiting
 * past the window to learn the exact value would only burn the upstream's
 * concurrency slot without changing the decision.
 */
export type PerformanceShadowOutcome = 'success' | 'timeout' | 'error';

export type PerformanceShadowAttempt = {
  atMs: number;
  outcome: PerformanceShadowOutcome;
  /** Success only: observed time to first byte. */
  firstByteLatencyMs: number | null;
  /** Timeout only: the window that expired, i.e. the censoring point. */
  budgetMs: number | null;
};

const attemptsByKey = new Map<string, PerformanceShadowAttempt[]>();
/** Attempts kept per key: enough shape, cheap to scan on every request. */
const ATTEMPT_WINDOW_MAX = 60;
const ATTEMPT_TTL_MS = 6 * 60 * 60 * 1000;
/** Samples required before the window estimator is allowed to override. */
export const FIRST_BYTE_WINDOW_MIN_SAMPLES = 8;
/**
 * Headroom above an observed fast-byte sample, added as a candidate window.
 * Without it the candidate set can never exceed the slowest success ever seen,
 * so the first answer slower than that gets censored and the window is stuck.
 */
export const FIRST_BYTE_WINDOW_HEADROOM_MULTIPLIER = 1.35;
/**
 * Recent TTFT attempts (oldest -> newest) inspected by the escalation trigger.
 * A sliding ratio is used instead of a tail streak: peak-hour traffic
 * interleaves fast and slow answers, so one 2s success used to reset a tail
 * counter and the window never moved off the floor all through the peak.
 */
export const FIRST_BYTE_WINDOW_TRIGGER_WINDOW = 6;
/** Timeouts inside that sliding window that make the window itself the suspect. */
export const FIRST_BYTE_WINDOW_TRIGGER_TIMEOUTS = 2;
/** Additive ladder step, used for both escalation and decay. */
export const FIRST_BYTE_WINDOW_LADDER_STEP_MS = 4_000;
/** Attempts a raised window is held for before any decay is considered. */
export const FIRST_BYTE_WINDOW_HOLD_ATTEMPTS = 10;
/** Consecutive fast answers required before the window steps one rung down. */
export const FIRST_BYTE_WINDOW_DECAY_FAST_ATTEMPTS = 8;
/** A success is "fast" (decay evidence) below this share of the window. */
export const FIRST_BYTE_WINDOW_DECAY_FAST_RATIO = 0.6;
function sweepAttempts(nowMs = Date.now()): void {
  const cutoff = nowMs - ATTEMPT_TTL_MS;
  for (const [key, list] of attemptsByKey.entries()) {
    const kept = list.filter((attempt) => attempt.atMs >= cutoff);
    if (kept.length === 0) attemptsByKey.delete(key);
    else if (kept.length !== list.length) attemptsByKey.set(key, kept);
  }
}

/** Record one attempt for the survival curve (success, censored timeout, or error). */
export function recordPerformanceShadowAttempt(input: {
  key: PerformanceShadowKey;
  outcome: PerformanceShadowOutcome;
  firstByteLatencyMs?: number | null;
  budgetMs?: number | null;
  nowMs?: number;
}): void {
  const siteId = Math.trunc(input.key.siteId);
  const modelName = normalizeModelName(input.key.modelName);
  if (siteId <= 0 || !modelName) return;
  const atMs = input.nowMs ?? Date.now();
  const firstByteLatencyMs = input.outcome === 'success'
    && Number.isFinite(input.firstByteLatencyMs)
    ? Math.max(0, Number(input.firstByteLatencyMs))
    : null;
  // An attempt without a usable measurement teaches nothing.
  if (input.outcome === 'success' && firstByteLatencyMs === null) return;
  const budgetMs = Number.isFinite(input.budgetMs) ? Math.max(0, Number(input.budgetMs)) : null;
  if (input.outcome === 'timeout' && (budgetMs === null || budgetMs <= 0)) return;

  const key = buildPerformanceShadowKey({ ...input.key, siteId, modelName });
  const list = attemptsByKey.get(key) ?? [];
  list.push({ atMs, outcome: input.outcome, firstByteLatencyMs, budgetMs });
  if (list.length > ATTEMPT_WINDOW_MAX) list.splice(0, list.length - ATTEMPT_WINDOW_MAX);
  attemptsByKey.set(key, list);
  sweepAttempts(atMs);
}

export function listPerformanceShadowAttempts(
  key: PerformanceShadowKey,
  nowMs = Date.now(),
): PerformanceShadowAttempt[] {
  sweepAttempts(nowMs);
  const storeKey = buildPerformanceShadowKey(key);
  return (attemptsByKey.get(storeKey) ?? []).map((attempt) => ({ ...attempt }));
}

/**
 * Sequencing policy applied on top of the cost optimum below.
 *
 * The optimiser is a pure function of the sample set, so it has no memory: from
 * the same samples it returns the same answer, and that answer is the floor
 * whenever every success sits below it AND the timeouts were cut at it. In that
 * state every window >= max(slowest success, censoring point) scores *identically*
 * (a censored attempt is charged min(W, its own expiry), and no new success is
 * unlocked), and the tie-break takes the smallest candidate — so the floor is an
 * absorbing state, not an optimum. Leaving it then requires a success that got
 * past the floor, which is exactly what the floor prevented.
 *
 * Production evidence (2026-10-26, one relay, one peak window): the window sat at
 * the 8s floor for 21 of 33 attempts while 12% of that site's successful answers
 * arrived above 8s.
 *
 * So the ordering is done here, by replaying the attempt series:
 *  - escalate once the sliding window holds enough timeouts (interleaved fast
 *    answers no longer reset the counter), jumping to DOUBLE the window —
 *    widened immediately when a success anchors higher;
 *  - hold the raised window for a run of attempts, so a single fast answer
 *    cannot undo it — the site is jittering, not fast again;
 *  - release only after the hold expires AND the site has answered fast
 *    repeatedly, dropping to the site's own P90 x headroom of the successes
 *    observed since the escalation (capped by the current window, never a
 *    release upward), i.e. escalation is immediate and decay is slow.
 *
 * Doubling from below replaces the +4s additive ladder. A censored timeout
 * only proves T >= the window that cut it, so a fixed step pays one failed
 * request per step and the step distance is pure guesswork: production
 * 2026-11-02 measured p90 TTFT at 22.6s and p95 at 35.1s (120s ceiling), so
 * reaching that tail from the 8s floor cost ~7 sacrificial timeouts per
 * bucket, spread over hours on low-traffic keys — while each one also banked
 * a cooldown on the channel, which is what surfaced as "the site never gets
 * routed to". A half-gap jump (8 -> 64s) was rejected too: on a genuinely
 * dead channel that is a ~1 minute free wait on the second probe, and dead
 * channels are cooldown/failover's job, not the window's. Doubling keeps
 * every dead-channel probe small (16/32/64) while the success anchor still
 * lands live slow channels on their real tail in one jump. x1.5 (the old
 * ratchet experiment) pinned 12 attempts at the ceiling because its steps
 * were small enough to keep stepping; the P90-anchored release means an
 * overshoot decays in one step to the site's observed tail, not one rung per
 * 8 fast answers.
 */
export function replayFirstByteWindowPolicy(input: {
  attempts: PerformanceShadowAttempt[];
  floorMs: number;
  ceilingMs: number;
}): number {
  const floorMs = Math.max(0, Math.trunc(input.floorMs));
  const ceilingMs = Math.max(floorMs, Math.trunc(input.ceilingMs));
  let windowMs = floorMs;
  let holdRemaining = 0;
  let fastRun = 0;
  let maxSuccessMs = 0;
  // Successes observed since the newest escalation — the release anchor below
  // may only use evidence this wide window itself produced, otherwise a slow
  // success from the pre-escalation era keeps the window pinned forever.
  const sinceEscalation: number[] = [];
  const recent: PerformanceShadowOutcome[] = [];
  for (const attempt of input.attempts) {
    if (attempt.outcome === 'success' && attempt.firstByteLatencyMs !== null) {
      maxSuccessMs = Math.max(maxSuccessMs, attempt.firstByteLatencyMs);
      sinceEscalation.push(attempt.firstByteLatencyMs);
    }
    recent.push(attempt.outcome);
    if (recent.length > FIRST_BYTE_WINDOW_TRIGGER_WINDOW) recent.shift();
    const timeoutsInWindow = recent.filter((outcome) => outcome === 'timeout').length;
    // Escalate only when THIS attempt is one of the timeouts: the sliding
    // window keeps holding the earlier ones for a few more attempts, so
    // triggering on the count alone would ratchet one rung per attempt —
    // including on healthy answers — straight to the ceiling.
    if (attempt.outcome === 'timeout' && timeoutsInWindow >= FIRST_BYTE_WINDOW_TRIGGER_TIMEOUTS) {
      // The incumbent window is the suspect: give the site one attempt wide
      // enough to prove itself, but never wider than the policy ceiling.
      // Exponential from below (x2): a dead channel climbs 16/32/64 instead
      // of eating a 64s+ wait on its second probe, and a live slow channel
      // rides the success anchor (maxSuccess x headroom) to wide coverage in
      // ONE jump — the evidence decides the step, and a timeout from a
      // channel that has never answered is only ever a doubling.
      const anchored = Math.max(
        windowMs * 2,
        windowMs + FIRST_BYTE_WINDOW_LADDER_STEP_MS,
        maxSuccessMs * FIRST_BYTE_WINDOW_HEADROOM_MULTIPLIER,
      );
      windowMs = Math.min(ceilingMs, Math.max(floorMs, Math.round(anchored)));
      holdRemaining = FIRST_BYTE_WINDOW_HOLD_ATTEMPTS;
      fastRun = 0;
      sinceEscalation.length = 0;
      continue;
    }
    if (holdRemaining > 0) {
      holdRemaining -= 1;
      fastRun = 0;
      continue;
    }
    if (attempt.outcome === 'success'
      && attempt.firstByteLatencyMs !== null
      && attempt.firstByteLatencyMs < windowMs * FIRST_BYTE_WINDOW_DECAY_FAST_RATIO) {
      fastRun += 1;
      if (fastRun >= FIRST_BYTE_WINDOW_DECAY_FAST_ATTEMPTS) {
        // Release to the site's own tail: P90 of the successes this window
        // itself observed, with the estimator's headroom. Still-slow successes
        // keep the width (a bimodal relay must keep catching its slow mode);
        // a recovered link lands one jump above its fast mode, not one ladder
        // rung per 8 answers. Capped by the current window — decay only goes
        // down — and falls back to the old additive step when no success is
        // available to anchor on.
        const sorted = [...sinceEscalation].sort((a, b) => a - b);
        const releaseMs = sorted.length > 0
          ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.9))]!
            * FIRST_BYTE_WINDOW_HEADROOM_MULTIPLIER
          : windowMs - FIRST_BYTE_WINDOW_LADDER_STEP_MS;
        windowMs = Math.max(floorMs, Math.min(windowMs, Math.round(releaseMs)));
        fastRun = 0;
      }
      continue;
    }
    fastRun = 0;
  }
  return Math.min(ceilingMs, Math.max(floorMs, windowMs));
}

/**
 * How many recent attempts the adaptive floor reads. Long enough to keep a
 * jitter sample in view, short enough that a link which recovered stops paying
 * for an old timeout.
 */
export const FIRST_BYTE_WINDOW_FLOOR_LOOKBACK = 20;
/**
 * Consecutive fast answers that retire a lifted floor.
 *
 * The lift is one-way by construction: it reads a censored timeout as
 * "T >= budget" and raises the floor to double the window that cut it.
 * Since that window is the floor, each further timeout raises the floor again —
 * on a link that has recovered there is nothing left to lower it except the
 * censored rows sliding out of the lookback, which on a low-traffic bucket
 * means hours of every answer waiting for a tail that is gone. A sustained run
 * of answers well below the lifted floor is the missing evidence in the other
 * direction, so it releases the lift — to the site's own tail (P90 x headroom
 * of the successes since the newest censored sample), not to the static floor.
 */
export const FIRST_BYTE_WINDOW_FLOOR_RELEASE_FAST_ATTEMPTS = 6;

/**
 * Floor for the first-byte window, learned from the site's own attempt history.
 *
 * Observed successes alone cannot escape a window that censors the tail: a site
 * answering in 2s nine times out of ten and 9s the tenth shows only 2s
 * successes while the window sits at 8s, so their P90 never proves the tail
 * exists. A censored timeout is the missing evidence — it says T >= its budget.
 * An ISOLATED timeout (preceded by a success) therefore lifts the floor to
 * DOUBLE the budget it was cut at — the same evidence-scaled escalation the
 * policy ladder uses. The old +4s rung here matched the original additive
 * ladder, and production showed that ladder is what fails: MetapiMesh sat at
 * the 8s floor for ~1h after deploy because isolated censored timeouts were
 * each re-lifting it by one 4s rung (8 -> 10 -> 12 -> 16s), the identical
 * "one failed request per 4 seconds" tax the escalation was fixed for.
 * A run of consecutive timeouts does not lift at all: that is a dead channel,
 * not a jittery one, and ratcheting there would pin the window at the ceiling
 * and make every failure slow.
 *
 * The lift is released again after a run of fast answers (see
 * FIRST_BYTE_WINDOW_FLOOR_RELEASE_FAST_ATTEMPTS), so a recovered link does not
 * keep paying for a timeout it already outlived.
 *
 * Deliberately not derived from a success percentile: the cost optimiser
 * already prices observed successes, and a bimodal relay's slow mode (45s) must
 * stay a deliberate rejection, not become an unyielding floor.
 */
export function resolveAdaptiveFirstByteFloorMs(input: {
  attempts: PerformanceShadowAttempt[];
  floorMs: number;
  ceilingMs: number;
}): number {
  const ceilingMs = Math.max(0, Math.trunc(input.ceilingMs));
  const floorMs = Math.max(0, Math.min(Math.trunc(input.floorMs), ceilingMs));
  const recent = input.attempts.slice(-FIRST_BYTE_WINDOW_FLOOR_LOOKBACK);

  let censoredFloorMs = 0;
  let lastCensoredIndex = -1;
  for (let index = 1; index < recent.length; index += 1) {
    const attempt = recent[index]!;
    if (attempt.outcome !== 'timeout' || attempt.budgetMs === null) continue;
    if (recent[index - 1]!.outcome !== 'success') continue;
    // Same evidence-scaled step as the policy ladder: a censored timeout
    // proves T >= budget, and doubling reaches the real tail in 1-2 probes.
    // The +4s floor-only case keeps progress when the budget is at the floor
    // itself (8s -> 16s beats 8s -> 12s -> 16s at the same probe count).
    const candidate = Math.max(attempt.budgetMs * 2, attempt.budgetMs + FIRST_BYTE_WINDOW_LADDER_STEP_MS);
    if (candidate >= censoredFloorMs) {
      censoredFloorMs = candidate;
      lastCensoredIndex = index;
    }
  }

  if (censoredFloorMs <= 0) return floorMs;

  const liftedMs = Math.min(ceilingMs, Math.max(floorMs, censoredFloorMs));
  // Release target. Falling back to the static floor would hand the recovered
  // answers' upper half straight back to the censoring zone — a site that now
  // answers in 12-13s does not want an 8s floor, it wants its own tail. P90 of
  // the successes seen since the newest timeout, with the same 1.35 headroom the
  // estimator uses, clamped to [static floor, ceiling]. P95 is deliberately not
  // used: the lookback holds at most 20 attempts, where P95 is the second
  // largest sample, so one 45s outlier would set the floor.
  const successSinceCensor: number[] = [];
  for (let index = lastCensoredIndex + 1; index < recent.length; index += 1) {
    const attempt = recent[index]!;
    if (attempt.outcome === 'success' && attempt.firstByteLatencyMs !== null) {
      successSinceCensor.push(attempt.firstByteLatencyMs);
    }
  }
  successSinceCensor.sort((a, b) => a - b);
  const releaseTargetMs = successSinceCensor.length > 0
    ? Math.min(ceilingMs, Math.max(
      floorMs,
      Math.round(
        successSinceCensor[Math.min(
          successSinceCensor.length - 1,
          Math.floor((successSinceCensor.length - 1) * 0.9),
        )]! * FIRST_BYTE_WINDOW_HEADROOM_MULTIPLIER,
      ),
    ))
    : floorMs;

  let fastRun = 0;
  for (let index = lastCensoredIndex + 1; index < recent.length; index += 1) {
    const attempt = recent[index]!;
    const isFast = attempt.outcome === 'success'
      && attempt.firstByteLatencyMs !== null
      && attempt.firstByteLatencyMs < liftedMs * FIRST_BYTE_WINDOW_DECAY_FAST_RATIO;
    fastRun = isFast ? fastRun + 1 : 0;
  }
  if (fastRun >= FIRST_BYTE_WINDOW_FLOOR_RELEASE_FAST_ATTEMPTS) return releaseTargetMs;

  return liftedMs;
}


/**
 * Pick the first-byte window that minimises **time per usable answer**:
 *
 *   cost(W) = E[min(T, W)] / P(T <= W)
 *
 * Waiting longer than the mixture's fast mode buys very little success while
 * paying the full wait on every attempt, so this metric usually prefers a
 * SHORTER window than a mean-based heuristic — and it needs no multiplier
 * guess, so it can never overshoot the configured ceiling by construction.
 *
 * Two corrections keep that preference from degenerating into a ratchet:
 * censored attempts are charged their own expiry point (not the candidate
 * window), and candidates include headroom above every observed success so the
 * window can widen again after a shrink. A trailing run of timeouts escalates
 * instead of optimising, because at that point the window is the suspect.
 *
 * `currentMs` adds hysteresis: keep the incumbent unless the alternative is
 * measurably better, so the window does not oscillate request to request. The
 * sequencing policy below (`replayFirstByteWindowPolicy`) supplies the memory
 * this pure optimiser lacks, and can only ever raise the result — a holder
 * window is not an optimum, so no amount of fast samples may undo it early.
 */
export function estimateFirstByteWindowMs(input: {
  key: PerformanceShadowKey;
  floorMs: number;
  ceilingMs: number;
  currentMs?: number | null;
  minSamples?: number;
  nowMs?: number;
}): number | null {
  const ceilingMs = Math.trunc(input.ceilingMs);
  if (!Number.isFinite(ceilingMs) || ceilingMs <= 0) return null;
  const floorMs = Math.max(0, Math.min(Math.trunc(input.floorMs), ceilingMs));
  const minSamples = Math.max(2, Math.trunc(input.minSamples ?? FIRST_BYTE_WINDOW_MIN_SAMPLES));
  const attempts = listPerformanceShadowAttempts(input.key, input.nowMs);
  if (attempts.length < minSamples) return null;

  // Errors (bad key, model removed, 4xx/5xx) say nothing about first-byte
  // latency. Folding them into the ratio made a busy site look "slow to answer"
  // and pushed the window down for a reason that had nothing to do with TTFT.
  const ttftAttempts = attempts.filter(
    (attempt) => attempt.outcome === 'success' || attempt.outcome === 'timeout',
  );
  if (ttftAttempts.length < minSamples) return null;
  const n = ttftAttempts.length;

  let maxSuccessMs = 0;
  for (const attempt of ttftAttempts) {
    if (attempt.outcome === 'success' && attempt.firstByteLatencyMs !== null) {
      maxSuccessMs = Math.max(maxSuccessMs, attempt.firstByteLatencyMs);
    }
  }

  // The static floor is a last resort; the site's own history decides where the
  // floor really sits. See resolveAdaptiveFirstByteFloorMs for why a censored
  // timeout — not a success percentile — is the evidence that breaks the loop.
  const adaptiveFloorMs = resolveAdaptiveFirstByteFloorMs({
    attempts: ttftAttempts,
    floorMs,
    ceilingMs,
  });

  // Candidate windows. Headroom points above every observed success are what
  // let the window ever grow again: without them the candidate set tops out at
  // "the slowest answer we have ever seen", so the next slow answer is censored
  // before it can become a sample, and the ceiling silently becomes the largest
  // success instead of the configured one.
  const points = new Set<number>([adaptiveFloorMs, ceilingMs]);
  const clampWindow = (value: number) => Math.min(ceilingMs, Math.max(adaptiveFloorMs, Math.round(value)));
  for (const attempt of ttftAttempts) {
    if (attempt.outcome === 'success' && attempt.firstByteLatencyMs !== null) {
      points.add(clampWindow(attempt.firstByteLatencyMs));
      points.add(clampWindow(attempt.firstByteLatencyMs * FIRST_BYTE_WINDOW_HEADROOM_MULTIPLIER));
    }
  }
  if (maxSuccessMs > 0) {
    points.add(clampWindow(maxSuccessMs * FIRST_BYTE_WINDOW_HEADROOM_MULTIPLIER));
    // One ladder rung above the slowest healthy answer — a cheap "wider" point
    // for the curve to score; the sequencing policy itself jumps half the gap
    // to the ceiling rather than landing here.
    points.add(clampWindow(Math.max(maxSuccessMs, adaptiveFloorMs) + FIRST_BYTE_WINDOW_LADDER_STEP_MS));
  }
  const candidates = [...points].sort((a, b) => a - b);

  const score = (windowMs: number): number => {
    let successes = 0;
    let totalCost = 0;
    for (const attempt of ttftAttempts) {
      if (attempt.outcome === 'success'
        && attempt.firstByteLatencyMs !== null
        && attempt.firstByteLatencyMs <= windowMs) {
        successes += 1;
        totalCost += attempt.firstByteLatencyMs;
        continue;
      }
      // Censored attempt. We only know it outlived its own expiry point, so a
      // wider candidate window must NOT be charged more than that expiry:
      // otherwise every past timeout grows more expensive the further we widen,
      // which is a permanent mathematical bias toward shrinking the window.
      totalCost += attempt.outcome === 'timeout' && attempt.budgetMs !== null
        ? Math.min(windowMs, attempt.budgetMs)
        : windowMs;
    }
    if (successes <= 0) return Number.POSITIVE_INFINITY;
    return (totalCost / n) / (successes / n);
  };

  let bestMs = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const value = score(candidate);
    if (value < bestScore - 1e-9) {
      bestScore = value;
      bestMs = candidate;
    }
  }
  // No window produced a single success: the site is not merely slow, it is
  // failing. Stay out of the way and let the caller keep its configured value.
  if (!Number.isFinite(bestScore)) return null;

  let optimumMs = bestMs;
  const currentMs = input.currentMs;
  if (typeof currentMs === 'number' && Number.isFinite(currentMs) && currentMs > 0) {
    const currentClamped = Math.min(ceilingMs, Math.max(adaptiveFloorMs, Math.trunc(currentMs)));
    const currentScore = score(currentClamped);
    // 15% improvement needed to move; avoids flapping on noisy samples.
    if (Number.isFinite(currentScore) && bestScore > currentScore * 0.85) optimumMs = currentClamped;
  }

  // Ordering policy. The optimiser cannot leave a floor its own samples made
  // absorbing — from the same samples it recomputes the same floor — so the
  // sequence itself decides: escalate on the sliding timeout ratio, hold the
  // raised window, decay only after a sustained fast run. It can only raise the
  // optimiser's answer, never lower it, and its widening is bounded by the same
  // configured first-byte timeout that bounds every single attempt.
  const policyWindowMs = replayFirstByteWindowPolicy({
    attempts: ttftAttempts,
    floorMs: adaptiveFloorMs,
    ceilingMs,
  });
  // Both the cost optimum and the sequencing policy stay inside the operator's
  // configured ceiling. There is no separate speculative cap: a narrower one
  // would silently override the operator and re-create the absorbing state one
  // ceiling higher — a bucket whose healthy first byte is 25-45s would 408
  // forever, and every 408 would then "prove" the window should stay there.
  return Math.min(ceilingMs, Math.max(adaptiveFloorMs, Math.max(optimumMs, policyWindowMs)));
}

function sweepPerformanceShadowMetrics(nowMs = Date.now()): void {
  const cutoff = nowMs - PERFORMANCE_SHADOW_TTL_MS;
  for (const [key, value] of metricsByKey.entries()) {
    if (value.updatedAtMs < cutoff) metricsByKey.delete(key);
  }
  while (metricsByKey.size > PERFORMANCE_SHADOW_MAX_ENTRIES) {
    const oldestKey = metricsByKey.keys().next().value;
    if (!oldestKey) break;
    metricsByKey.delete(oldestKey);
  }
}

function normalizeModelName(modelName: string): string {
  return modelName.trim().toLowerCase();
}

export function buildPerformanceShadowKey(input: PerformanceShadowKey): string {
  const routeId = Number.isFinite(input.routeId) && (input.routeId ?? 0) > 0
    ? Math.trunc(input.routeId as number)
    : 0;
  return `${routeId}:${Math.trunc(input.siteId)}:${normalizeModelName(input.modelName)}:${input.isStream ? 'stream' : 'nonstream'}`;
}

function updateEwma(previous: number | null, sample: number | null, alpha: number): number | null {
  if (sample === null || !Number.isFinite(sample) || sample < 0) return previous;
  if (previous === null) return sample;
  return (alpha * sample) + ((1 - alpha) * previous);
}

export function recordPerformanceShadowSample(input: {
  key: PerformanceShadowKey;
  latencyMs: number;
  firstByteLatencyMs?: number | null;
  completionTokens?: number | null;
  nowMs?: number;
  alpha?: number;
}): PerformanceShadowMetrics | null {
  const siteId = Math.trunc(input.key.siteId);
  const modelName = normalizeModelName(input.key.modelName);
  const latencyMs = Number(input.latencyMs);
  if (siteId <= 0 || !modelName || !Number.isFinite(latencyMs) || latencyMs < 0) return null;

  const alpha = Math.min(1, Math.max(0.01, Number(input.alpha ?? DEFAULT_ALPHA)));
  const key = buildPerformanceShadowKey({ ...input.key, siteId, modelName });
  const previous = metricsByKey.get(key);
  const isStream = input.key.isStream;
  const firstByteLatencyMs = isStream && Number.isFinite(input.firstByteLatencyMs)
    ? Math.max(0, Number(input.firstByteLatencyMs))
    : null;
  const completionTokens = Number(input.completionTokens);
  const tps = isStream
    && firstByteLatencyMs !== null
    && Number.isFinite(completionTokens)
    && completionTokens >= MIN_TPS_COMPLETION_TOKENS
    && latencyMs > firstByteLatencyMs
    ? (completionTokens / ((latencyMs - firstByteLatencyMs) / 1000))
    : null;
  const next: PerformanceShadowMetrics = {
    key,
    routeId: Number.isFinite(input.key.routeId) && (input.key.routeId ?? 0) > 0
      ? Math.trunc(input.key.routeId as number)
      : null,
    siteId,
    modelName,
    isStream,
    ttftEwmaMs: updateEwma(previous?.ttftEwmaMs ?? null, firstByteLatencyMs, alpha),
    tpsEwma: updateEwma(previous?.tpsEwma ?? null, tps, alpha),
    e2eLatencyEwmaMs: updateEwma(previous?.e2eLatencyEwmaMs ?? null, latencyMs, alpha),
    sampleCount: (previous?.sampleCount ?? 0) + 1,
    updatedAtMs: input.nowMs ?? Date.now(),
  };
  metricsByKey.delete(key);
  metricsByKey.set(key, next);
  sweepPerformanceShadowMetrics(next.updatedAtMs);
  return { ...next };
}

export function getPerformanceShadowMetrics(key: PerformanceShadowKey, nowMs = Date.now()): PerformanceShadowMetrics | null {
  sweepPerformanceShadowMetrics(nowMs);
  const storeKey = buildPerformanceShadowKey(key);
  const value = metricsByKey.get(storeKey);
  if (value) {
    metricsByKey.delete(storeKey);
    metricsByKey.set(storeKey, value);
  }
  return value ? { ...value } : null;
}


export function listPerformanceShadowMetricsByRouteId(routeId: number, nowMs = Date.now()): PerformanceShadowMetrics[] {
  sweepPerformanceShadowMetrics(nowMs);
  const normalizedRouteId = Math.trunc(routeId);
  return [...metricsByKey.values()]
    .filter((value) => value.routeId === normalizedRouteId)
    .map((value) => ({ ...value }));
}

export function clearPerformanceShadowMetrics(): void {
  metricsByKey.clear();
  attemptsByKey.clear();
}

export const performanceShadowConstants = {
  defaultAlpha: DEFAULT_ALPHA,
  minTpsCompletionTokens: MIN_TPS_COMPLETION_TOKENS,
  ttlMs: PERFORMANCE_SHADOW_TTL_MS,
  maxEntries: PERFORMANCE_SHADOW_MAX_ENTRIES,
};
