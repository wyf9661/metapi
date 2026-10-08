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
  isReasoningEffortRejection,
  readReasoningEffortFromBody,
  resolveInPlaceEffortRetryCeiling,
  stripReasoningEffortFromBody,
} from '../../services/reasoningEffort.js';
import {
  clampRequestBodyToSiteEffortCeiling,
  learnReasoningEffortCeilingFromFailure,
} from '../../services/siteReasoningEffortCapabilityService.js';

/** True when this attempt failure is an effort-value rejection worth an in-place retry. */
export function isEffortRejectionRetryable(status: number, errText: string | null | undefined): boolean {
  return status === 400 && isReasoningEffortRejection(errText);
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
 * 1. `none` rejection — the model does not support disabling reasoning at all.
 *    The field is stripped; no ceiling is learned (there is no ladder rung
 *    below `none`).
 *
 * 2. Ladder rejection — a specific effort value was outside the relay's
 *    accepted ladder.  The ceiling for this site+protocol is recorded
 *    (preferably from the listed ladder, otherwise one mechanical step below
 *    the rejected value), and every shared body is stepped one rung down.
 *    The build-time clamp later constrains the body further if needed.
 *
 * Returns true when a body was actually changed, false on no-op.
 */
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
  if (!isEffortRejectionRetryable(input.status, input.errText)) return false;

  const candidateBodies: Array<Record<string, unknown>> = [];
  for (const body of input.bodies) {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      candidateBodies.push(body);
    }
  }
  if (candidateBodies.length === 0) return false;

  // — `none` rejection: strip the field from every source body —
  if (isNoneReasoningEffortRejection(input.errText)) {
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