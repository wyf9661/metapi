import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The usage log shows the reasoning effort a downstream client asked for, but
 * the log writers live in several route files that only receive the values they
 * already pass along. Rather than threading a new parameter through every
 * `logProxy` helper and call site, the proxy captures the effort once per
 * request (HTTP hook) or per websocket message and the log store reads it from
 * the async context.
 */
const reasoningEffortContext = new AsyncLocalStorage<string | null>();

/** Canonical vocabulary shared by the OpenAI and Anthropic APIs. */
const REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Spellings that collapse onto a value above (compared after separators are removed). */
const REASONING_EFFORT_ALIASES: Record<string, string> = {
  extrahigh: 'xhigh',
  veryhigh: 'xhigh',
};

function canonicalReasoningEffort(raw: string): string | null {
  const collapsed = raw.trim().toLowerCase().replace(/[-_\s]/g, '');
  if (!collapsed) return null;
  if ((REASONING_EFFORT_VALUES as readonly string[]).includes(collapsed)) return collapsed;
  return REASONING_EFFORT_ALIASES[collapsed] ?? null;
}

/**
 * Canonicalizes a client-supplied effort so the column stays consistent
 * (`XHIGH`/`extra-high` → `xhigh`). Unknown names are still shown verbatim —
 * upstreams invent values and the log must not silently drop what was sent —
 * just bounded to keep a row readable.
 */
export function normalizeReasoningEffort(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const canonical = canonicalReasoningEffort(trimmed);
  if (canonical) return canonical;
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
}

/**
 * Pull the effort out of a downstream request body:
 * - chat/completions and most OpenAI-compatible clients: `reasoning_effort`
 * - Responses API: `reasoning: { effort }` (and `reasoning_effort` when sent)
 * - Anthropic-style clients: `output_config: { effort }`
 * Returns null when the client did not ask for a specific effort, which the log
 * renders as `-`.
 */
export function extractReasoningEffort(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  const direct = normalizeReasoningEffort(record.reasoning_effort);
  if (direct) return direct;

  const reasoning = record.reasoning;
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const nested = normalizeReasoningEffort((reasoning as Record<string, unknown>).effort);
    if (nested) return nested;
  }

  const outputConfig = record.output_config;
  if (outputConfig && typeof outputConfig === 'object' && !Array.isArray(outputConfig)) {
    const nested = normalizeReasoningEffort((outputConfig as Record<string, unknown>).effort);
    if (nested) return nested;
  }

  return null;
}

/**
 * Some upstreams encode the effort in the model name instead of the body
 * (`gpt-5-high`, `glm-5.2-xhigh`). Only an exact effort word in the last
 * dash/underscore/space segment counts — never a partial match, so models like
 * `deepseek-v4-flash` or `claude-opus-4-6-thinking` stay unknown.
 */
export function inferReasoningEffortFromModelName(model: unknown): string | null {
  if (typeof model !== 'string') return null;
  const lastPathSegment = model.trim().split('/').pop() || '';
  const segments = lastPathSegment.split(/[-_\s]+/).filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) return null;
  return canonicalReasoningEffort(lastSegment);
}

/** Resolve the effort for a plain HTTP request: explicit fields, then the model name. */
export function resolveRequestReasoningEffort(body: unknown, model?: unknown): string | null {
  return extractReasoningEffort(body) ?? inferReasoningEffortFromModelName(model) ?? null;
}

/**
 * Resolve the effort for a websocket message. Codex (and the Responses
 * websocket protocol generally) sends `reasoning` on the first message of a
 * session only; follow-up turns and `response.append` inherit it, so fall back
 * to the previous message, then to the model name.
 */
export function resolveWebsocketReasoningEffort(
  current: unknown,
  previous: unknown,
  model?: unknown,
): string | null {
  return extractReasoningEffort(current)
    ?? extractReasoningEffort(previous)
    ?? inferReasoningEffortFromModelName(model)
    ?? null;
}

/** Called from the proxy router's per-request hook and the websocket ingress. */
export function setCurrentReasoningEffort(effort: string | null): void {
  reasoningEffortContext.enterWith(effort);
}

export function getCurrentReasoningEffort(): string | null {
  return reasoningEffortContext.getStore() ?? null;
}

/**
 * Ascending ladder of the effort values relays accept. Index order IS the
 * capability order: a relay that rejects one rung is normally willing to take
 * the rung below it (a relay advertising low/medium/high rejects `max`, an
 * Anthropic-side conversion rejects `xhigh`).
 */
export const REASONING_EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** One rung down the ladder, or null at the floor / for an unknown spelling. */
export function nextLowerReasoningEffort(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = canonicalReasoningEffort(value) ?? value.trim().toLowerCase();
  const index = (REASONING_EFFORT_LADDER as readonly string[]).indexOf(collapsed);
  if (index <= 0) return null;
  return REASONING_EFFORT_LADDER[index - 1];
}

/**
 * Whether `candidate` sits on a higher rung than `cap`. Unknown spellings are
 * reported as not-higher so an unrecognised value is never rewritten.
 */
export function isReasoningEffortAbove(candidate: unknown, cap: unknown): boolean {
  if (typeof candidate !== 'string' || typeof cap !== 'string') return false;
  const candidateKey = canonicalReasoningEffort(candidate) ?? candidate.trim().toLowerCase();
  const capKey = canonicalReasoningEffort(cap) ?? cap.trim().toLowerCase();
  const candidateIndex = (REASONING_EFFORT_LADDER as readonly string[]).indexOf(candidateKey);
  const capIndex = (REASONING_EFFORT_LADDER as readonly string[]).indexOf(capKey);
  if (candidateIndex < 0 || capIndex < 0) return false;
  return candidateIndex > capIndex;
}

/**
 * Whether an upstream body-validation error is about the effort value. The
 * vocabulary varies by relay — `level "max" not supported, valid levels: low,
 * medium, high`, `field ReasoningEffort invalid, should be one of: ...` — but
 * every variant names the field or the accepted ladder, so match either.
 */
export function isReasoningEffortRejection(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  return /reasoning[_\s-]?effort|(invalid|not supported|unsupported)[^.]{0,40}effort|effort[^.]{0,40}(invalid|not supported|unsupported)|valid levels/i
    .test(errorText);
}

/** True when the upstream rejected `none` specifically — this is not a ladder
 * issue but a model that does not support disabling reasoning at all. We strip
 * the field on retry instead of stepping down. */
export function isNoneReasoningEffortRejection(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  return /does not support\s*[`'"]?\s*reasoning_effort\s*[`'"]?\s*value\s*[`'"]?\s*none\s*[`'"]?/i.test(errorText);
}

/** Remove every effort-bearing slot from a body (used when the upstream rejects
 * `none` — the model does not accept disabling reasoning, so the field must
 * simply not be sent). An emptied nested container (`reasoning`, `output_config`)
 * is dropped too, so the rebuilt request carries no trace of the field.
 * Returns true when anything was removed. */
export function stripReasoningEffortFromBody(
  body: Record<string, unknown> | null | undefined,
): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  let removed = false;

  if (typeof body.reasoning_effort === 'string') {
    delete body.reasoning_effort;
    removed = true;
  }

  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const holder = reasoning as Record<string, unknown>;
    if (typeof holder.effort === 'string') {
      delete holder.effort;
      removed = true;
    }
    if (Object.keys(holder).length === 0) delete body.reasoning;
  }

  const outputConfig = body.output_config;
  if (outputConfig && typeof outputConfig === 'object' && !Array.isArray(outputConfig)) {
    const holder = outputConfig as Record<string, unknown>;
    if (typeof holder.effort === 'string') {
      delete holder.effort;
      removed = true;
    }
    if (Object.keys(holder).length === 0) delete body.output_config;
  }

  return removed;
}

/**
 * Parse the accepted ladder out of a rejection that lists it verbatim
 * (`level "max" not supported, valid levels: low, medium, high`). Upstreams
 * that spell out their acceptance set let the in-place retry go straight to
 * the top accepted rung instead of stepping down one rejection at a time.
 * Returns null when no ladder is listed (or nothing in it is a known rung) —
 * callers then fall back to the mechanical one-rung step-down.
 */
export function parseAcceptedEffortLadderFromError(
  errorText: string | null | undefined,
): string[] | null {
  if (!errorText) return null;
  const match = /valid\s+levels\s*:\s*([a-z0-9,\s_-]+)/i.exec(errorText);
  if (!match) return null;
  const parsed = match[1]
    .split(',')
    .map((entry) => canonicalReasoningEffort(entry))
    .filter((entry): entry is string => !!entry);
  return parsed.length > 0 ? parsed : null;
}

/**
 * The effort ceiling an in-place retry against the SAME channel should use:
 * the highest rung of the ladder the upstream itself listed, or — when the
 * rejection does not spell one out — one rung below the rejected value.
 * Null when the rejected value already sits at the floor and nothing lower
 * can be tried.
 */
export function resolveInPlaceEffortRetryCeiling(input: {
  rejectedEffort: string | null | undefined;
  errorText: string | null | undefined;
}): string | null {
  const rejected = typeof input.rejectedEffort === 'string' ? input.rejectedEffort.trim() : '';
  if (!rejected) return null;
  const rejectedIndex = (REASONING_EFFORT_LADDER as readonly string[]).indexOf(
    canonicalReasoningEffort(rejected) ?? rejected.toLowerCase(),
  );
  if (rejectedIndex <= 0) return null;

  const accepted = parseAcceptedEffortLadderFromError(input.errorText);
  if (accepted) {
    // Highest listed rung that sits below the rejected value (a relay listing
    // the rejected value itself in its ladder would be contradictory).
    const belowRejected = accepted
      .map((entry) => (REASONING_EFFORT_LADDER as readonly string[]).indexOf(entry))
      .filter((index) => index >= 0 && index < rejectedIndex);
    if (belowRejected.length > 0) {
      return REASONING_EFFORT_LADDER[Math.max(...belowRejected)];
    }
    // The listed ladder contradicts the rejection (nothing below it): treat
    // like an unparsable list rather than giving up.
  }
  return REASONING_EFFORT_LADDER[rejectedIndex - 1];
}

/** Every effort-bearing key of a request body, with the object that holds it. */
export function collectReasoningEffortSlots(
  body: Record<string, unknown> | null | undefined,
): Array<{ holder: Record<string, unknown>; key: string }> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const slots: Array<{ holder: Record<string, unknown>; key: string }> = [];
  if (typeof body.reasoning_effort === 'string') {
    slots.push({ holder: body, key: 'reasoning_effort' });
  }
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const holder = reasoning as Record<string, unknown>;
    if (typeof holder.effort === 'string') slots.push({ holder, key: 'effort' });
  }
  const outputConfig = body.output_config;
  if (outputConfig && typeof outputConfig === 'object' && !Array.isArray(outputConfig)) {
    const holder = outputConfig as Record<string, unknown>;
    if (typeof holder.effort === 'string') slots.push({ holder, key: 'effort' });
  }
  return slots;
}

/** Read the effort out of a request body, whatever shape it uses. */
export function readReasoningEffortFromBody(
  body: Record<string, unknown> | null | undefined,
): string | null {
  const slot = collectReasoningEffortSlots(body)[0];
  return slot ? String(slot.holder[slot.key]) : null;
}

/**
 * Step the effort in a request body one rung down the ladder so a retry against
 * the same upstream carries a value its validator accepts. Covers the three
 * shapes a downstream body can use: `reasoning_effort`, `reasoning.effort`
 * (Responses API) and `output_config.effort` (Anthropic).
 *
 * Returns the new value, or null when there was nothing to downgrade. Callers
 * must gate this on an actual upstream rejection — the client's requested value
 * is sent first, and only a rejection trades capability for a request that can
 * complete.
 */
export function downgradeReasoningEffortInBody(body: Record<string, unknown> | null | undefined): string | null {
  let downgraded: string | null = null;
  for (const slot of collectReasoningEffortSlots(body)) {
    const next = nextLowerReasoningEffort(slot.holder[slot.key]);
    if (!next) continue;
    slot.holder[slot.key] = next;
    downgraded = next;
  }
  return downgraded;
}

/**
 * Force every effort slot of a body down to at most `cap`, whatever rung it
 * currently sits on. Used for the per-site memory of a rejection: once a relay
 * has told us a value is not in its ladder, later requests must not open with
 * the same rejected value again.
 *
 * Returns the value written, or null when nothing had to change.
 */
export function capReasoningEffortInBody(
  body: Record<string, unknown> | null | undefined,
  cap: string,
): string | null {
  let applied: string | null = null;
  for (const slot of collectReasoningEffortSlots(body)) {
    if (!isReasoningEffortAbove(slot.holder[slot.key], cap)) continue;
    slot.holder[slot.key] = cap;
    applied = cap;
  }
  return applied;
}
