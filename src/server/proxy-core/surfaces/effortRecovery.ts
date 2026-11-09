/**
 * Shared reasoning-effort rejection recovery for proxy surfaces.
 *
 * A 400 that names the reasoning-effort value is a request-shape verdict from
 * this relay, not a channel-health signal: the channel answered instantly,
 * the body shape needs fixing.  Every surface (chat / claude-messages /
 * responses) wires the same three pieces:
 *
 * 1. Build-time clamp — `clampRequestBodyToSiteEffortCeiling()` caps a
 *    freshly built endpoint body at the ceiling learned for this site+protocol.
 * 2. In-place retry predicate — `shouldRetryEffortInPlace()` gates a retry
 *    that redispatchs the SAME endpoint on the SAME channel instead of
 *    cascading elsewhere with a value the relay may also refuse.
 * 3. On-attempt-failure recovery — `recoverForEffortRejection()` strips the
 *    field (`none` rejection) or learns the ceiling and steps every shared
 *    source body down one rung, so the rebuilt retry carries the accepted value.
 *
 * The chat surface already had an inline version of this; the responses surface
 * was missing it entirely.  Both now import from this module.
 */
import {
  downgradeReasoningEffortInBody,
  isNoneReasoningEffortRejection,
  isReasoningEffortOffLadder,
  isReasoningEffortRejection,
  readReasoningEffortFromBody,
  resolveInPlaceEffortRetryCeiling,
  stripReasoningEffortFromBody,
} from '../../services/reasoningEffort.js';
import {
  clampRequestBodyToSiteEffortCeiling,
  learnReasoningEffortCeilingFromFailure,
} from '../../services/siteReasoningEffortCapabilityService.js';
import { isThinkingModePassbackError } from '../../transformers/shared/endpointCompatibility.js';
import { stripThinkingModeFromBody } from '../../services/reasoningEffort.js';

/**
 * True when this attempt failure is worth an in-place effort retry.
 *
 * Two independent routes, because relays differ in how much they say:
 *  - the error names the effort value (classic ladder / enum rejection), or
 *  - the body we just sent carried an off-ladder effort (`none`, `off`, …) and the
 *    relay answered 400 without naming anything. Judging by the value keeps this
 *    working against relays that reject the body with a bare "invalid request to
 *    model"; canonical values stay untouched on such a 400 (the body may be wrong
 *    for an unrelated reason and stripping would hide that).
 */
export function isEffortRejectionRetryable(
  status: number,
  errText: string | null | undefined,
  sentEffort?: string | null,
): boolean {
  if (status !== 400) return false;
  if (isReasoningEffortRejection(errText)) return true;
  return isReasoningEffortOffLadder(sentEffort);
}

/**
 * Clamp a freshly built endpoint body to the site's learned ceiling.
 * Re-exported so every surface uses the same wrapper name.
 */
export const clampBuiltBodyToEffortCeiling = clampRequestBodyToSiteEffortCeiling;

/**
 * Apply an effort rejection verdict to the shared source body/bodies the retry
 * rebuilds from.  Mutates them in-place so the in-place retry (called by
 * endpointFlow after onAttemptFailure) reads corrected values.
 *
 * Handles two kinds of verdict:
 *
 * 1. `none` / off-ladder sentinel rejection — the model does not accept the value
 *    (`none`, `off`, `ultra`, …).  The field is stripped; no ceiling is learned:
 *    there is no rung to step down from.
 *
 * 2. Ladder rejection — a specific effort value was outside the relay's
 *    accepted ladder.  The ceiling for this site+protocol is recorded
 *    (preferably from the listed ladder, otherwise one mechanical step below
 *    the rejected value), and every shared body is stepped one rung down.
 *    The build-time clamp later constrains the body further if needed.
 *
 * Returns true when a body was actually changed, false on no-op.
 */
/**
 * The effort value the relay actually judged: the final outbound body when the
 * caller has one (overrides merged), else the first source body that carries an
 * effort. Read from the body — never from the error text.
 */
function verdictEffort(input: {
  bodies: ReadonlyArray<Record<string, unknown> | null | undefined>;
  rejectedBody?: Record<string, unknown> | null;
}): string | null {
  const order = input.rejectedBody ? [input.rejectedBody, ...input.bodies] : input.bodies;
  for (const body of order) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
    const effort = readReasoningEffortFromBody(body as Record<string, unknown>);
    if (effort) return effort;
  }
  return null;
}

export function recoverForEffortRejection(input: {
  status: number;
  errText: string | null | undefined;
  siteId: number;
  endpoint: string;
  bodies: ReadonlyArray<Record<string, unknown> | null | undefined>;
  /**
   * The FINAL outbound body that was actually rejected (overrides merged).
   * The relay judged THIS body, so its effort is the verdict's subject; the
   * source bodies may still carry the client's (valid) value while a configured
   * override wrote the rejected one. Learning from the source value would
   * clamp the site one rung too low — or teach a ceiling when the client's
   * value was never rejected at all.
   */
  rejectedBody?: Record<string, unknown> | null;
}): boolean {
  const sent = verdictEffort(input);
  if (!isEffortRejectionRetryable(input.status, input.errText, sent)) return false;

  const candidateBodies: Array<Record<string, unknown>> = [];
  for (const body of input.bodies) {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      candidateBodies.push(body);
    }
  }
  if (candidateBodies.length === 0) return false;

  // The relay's text names nothing about effort (bare "invalid request to model"):
  // the only defensible action is to drop the off-ladder value we ourselves sent.
  // Canonical values are left alone — such a 400 may come from an unrelated defect
  // and silently stripping the field would hide it.
  if (!isReasoningEffortRejection(input.errText)) {
    if (!isReasoningEffortOffLadder(sent)) return false;
    let stripped = false;
    for (const body of candidateBodies) {
      if (stripReasoningEffortFromBody(body)) stripped = true;
    }
    return stripped;
  }

  // — `none` by wording, or any off-ladder value the relay judged: the field is
  //   stripped from every source body; no ceiling is learned (no rung to step to). —
  if (isNoneReasoningEffortRejection(input.errText) || isReasoningEffortOffLadder(sent)) {
    let changed = false;
    for (const body of candidateBodies) {
      if (stripReasoningEffortFromBody(body)) changed = true;
    }
    return changed;
  }

  // — ladder rejection: learn the ceiling, step every body down —
  // The verdict's subject is the body the relay actually saw (overrides
  // merged); fall back to the first source body when the caller has no
  // final-body snapshot (older call sites without overrides).
  const learningOrder = input.rejectedBody
    ? [input.rejectedBody, ...candidateBodies]
    : candidateBodies;
  let rejectedEffort: string | null = null;
  let cedingBody: Record<string, unknown> | null = null;
  for (const body of learningOrder) {
    const effort = readReasoningEffortFromBody(body);
    if (effort) {
      rejectedEffort = effort;
      cedingBody = body;
      break;
    }
  }
  if (!rejectedEffort || !cedingBody) return false;

  const taughtCeiling = resolveInPlaceEffortRetryCeiling({ rejectedEffort, errorText: input.errText });
  learnReasoningEffortCeilingFromFailure({
    siteId: input.siteId,
    endpoint: input.endpoint,
    errorText: input.errText,
    body: cedingBody,
    taughtCeiling,
  });

  let changed = false;
  for (const body of candidateBodies) {
    if (downgradeReasoningEffortInBody(body) !== null) changed = true;
  }
  return changed;
}

/** Re-export the body‑slot helpers so callers can still access them if needed. */
export {
  isReasoningEffortRejection,
  isNoneReasoningEffortRejection,
};

/**
 * Whether this attempt failed because the relay wants the conversation's prior
 * reasoning echoed back. The downstream OpenAI-shaped client never sends it, so
 * switching channels or faces reproduces the same 400 — the repair is to retry
 * once on the SAME channel and face with thinking turned off.
 */
export function recoverForThinkingPassback(input: {
  status: number;
  errText: string | null | undefined;
  bodies: ReadonlyArray<Record<string, unknown> | null | undefined>;
  rejectedBody?: Record<string, unknown> | null;
}): boolean {
  if (input.status !== 400 || !isThinkingModePassbackError(input.errText)) return false;
  let changed = false;
  for (const body of [...input.bodies, input.rejectedBody]) {
    if (body && stripThinkingModeFromBody(body)) changed = true;
  }
  return changed;
}

/** Retry predicate for the thinking pass-back verdict (bounded to one retry). */
export function isThinkingPassbackRetryable(status: number, errText: string | null | undefined): boolean {
  return status === 400 && isThinkingModePassbackError(errText);
}