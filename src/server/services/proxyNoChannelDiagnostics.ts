/**
 * Why did a request end up with no channel at all?
 *
 * Selection already computes every candidate's exclusion reasons
 * (`getCandidateEligibilityReasons`) and then throws them away: the proxy surface
 * only sees `null` and reports a bare "No available channels after retries".
 * A transient exclusion (channel cooldown, account/site status, token, context
 * window, downstream policy) is therefore undiagnosable after the fact — the row
 * state that caused it is usually gone by the time anyone looks, and the pool is
 * empty for a *reason* that was known at selection time.
 *
 * This keeps the last no-selection diagnostic per model so the failure report can
 * name the field that emptied the pool. It is diagnostics only: nothing here is
 * read by selection, and a missing entry changes no behavior.
 */

export type NoChannelCandidateReason = {
  code: string;
  message: string;
};

export type NoChannelCandidateDiagnostic = {
  channelId: number;
  reasons: NoChannelCandidateReason[];
};

/** Which step produced the empty selection. */
export type NoChannelDiagnosticStage =
  /** Every candidate on the matched route failed the hard eligibility check. */
  | 'no_eligible_candidate'
  /** Candidates were eligible, but the dispatch/scoring stage still selected none. */
  | 'dispatch_no_selection';

export type NoChannelDiagnostic = {
  model: string;
  recordedAtMs: number;
  stage: NoChannelDiagnosticStage;
  /** Candidates present on the matched route. */
  poolSize: number;
  candidates: NoChannelCandidateDiagnostic[];
};

/**
 * Short on purpose: the surface reports the failure within milliseconds of the
 * empty selection, so anything older than this belongs to a different request
 * and must not be attached to this one.
 */
const DIAGNOSTIC_TTL_MS = 120_000;
/** Bounded like the other runtime maps in this codebase (LRU-ish by insertion). */
const MAX_TRACKED_MODELS = 32;
const MAX_REPORTED_CANDIDATES = 5;
const MAX_REASON_TEXT = 300;

const diagnosticsByModel = new Map<string, NoChannelDiagnostic>();

function pruneExpired(nowMs: number): void {
  for (const [key, value] of diagnosticsByModel) {
    if (nowMs - value.recordedAtMs > DIAGNOSTIC_TTL_MS) diagnosticsByModel.delete(key);
  }
}

export function recordNoChannelDiagnostic(input: {
  model: string;
  stage: NoChannelDiagnosticStage;
  poolSize: number;
  candidates: Array<{ channelId: number; reasons: NoChannelCandidateReason[] }>;
  nowMs?: number;
}): void {
  const model = String(input.model || '').trim();
  if (!model) return;
  const nowMs = input.nowMs ?? Date.now();
  pruneExpired(nowMs);

  // An empty selection with no reason attached to any candidate is still worth
  // recording (it points at the dispatch/scoring stage), so do not drop the entry
  // just because every candidate came back clean.
  const candidates = input.candidates
    .filter((candidate) => candidate.reasons.length > 0)
    .slice(0, MAX_REPORTED_CANDIDATES)
    .map((candidate) => ({
      channelId: candidate.channelId,
      reasons: candidate.reasons.map((reason) => ({
        code: String(reason.code),
        message: String(reason.message || ''),
      })),
    }));

  if (diagnosticsByModel.size >= MAX_TRACKED_MODELS && !diagnosticsByModel.has(model)) {
    const oldestKey = diagnosticsByModel.keys().next().value;
    if (oldestKey !== undefined) diagnosticsByModel.delete(oldestKey);
  }

  diagnosticsByModel.set(model, {
    model,
    recordedAtMs: nowMs,
    stage: input.stage,
    poolSize: Math.max(0, Math.trunc(input.poolSize) || 0),
    candidates,
  });
}

/** Fresh diagnostic for this model, or null when none is recent enough to attribute. */
export function getNoChannelDiagnostic(model: string, nowMs: number = Date.now()): NoChannelDiagnostic | null {
  const key = String(model || '').trim();
  if (!key) return null;
  const entry = diagnosticsByModel.get(key);
  if (!entry) return null;
  if (nowMs - entry.recordedAtMs > DIAGNOSTIC_TTL_MS) {
    diagnosticsByModel.delete(key);
    return null;
  }
  return entry;
}

/**
 * One compact line naming what emptied the pool, e.g.
 * `候选排除=池 1 个,#460492:channel_cooldown(冷却中)`
 */
export function formatNoChannelDiagnostic(diagnostic: NoChannelDiagnostic): string {
  if (diagnostic.stage === 'dispatch_no_selection') {
    return `候选排除=池 ${diagnostic.poolSize} 个候选均通过资格判定，但派发阶段未选中`;
  }
  const parts = diagnostic.candidates.map((candidate) => {
    const reasons = candidate.reasons
      .map((reason) => (reason.message ? `${reason.code}(${reason.message})` : reason.code))
      .join('+');
    return `#${candidate.channelId}:${reasons}`;
  });
  const head = `候选排除=池 ${diagnostic.poolSize} 个`;
  const body = parts.length > 0 ? `,${parts.join(' | ')}` : ',原因未记录';
  const text = `${head}${body}`;
  return text.length > MAX_REASON_TEXT ? `${text.slice(0, MAX_REASON_TEXT)}…` : text;
}

export function __resetNoChannelDiagnosticsForTests(): void {
  diagnosticsByModel.clear();
}
