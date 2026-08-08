/**
 * Site-level request-body override (param_override).
 *
 * A site may carry a JSON `param_override` (stored as text on `sites`). Before
 * the outbound request is sent, its top-level keys are merged INTO the request
 * body (override wins). This lets an operator force parameters on a specific
 * upstream — e.g. pin `max_tokens`, a temperature, or append a vendor-only
 * field — regardless of what the downstream client sends.
 *
 * Semantics (mirroring octopus' param_override): shallow merge at the top
 * level; nested objects are replaced wholesale, not deep-merged. Only applied
 * to JSON request bodies.
 */

const MAX_PARAM_OVERRIDE_LENGTH = 4096;

export type ParseParamOverrideResult =
  | { valid: true; paramOverride: string | null }
  | { valid: false; error: string };

export function parseSiteParamOverrideInput(raw: unknown): ParseParamOverrideResult {
  if (raw === undefined || raw === null || raw === '') {
    return { valid: true, paramOverride: null };
  }
  if (typeof raw !== 'string') {
    return { valid: false, error: 'Invalid paramOverride. Expected a JSON string.' };
  }
  if (raw.length > MAX_PARAM_OVERRIDE_LENGTH) {
    return { valid: false, error: `Invalid paramOverride. Exceeds ${MAX_PARAM_OVERRIDE_LENGTH} chars.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, error: 'Invalid paramOverride. Not valid JSON.' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, error: 'Invalid paramOverride. Expected a JSON object.' };
  }

  return { valid: true, paramOverride: raw };
}

/**
 * Merge the site's param_override JSON into an outbound JSON request body.
 * Returns the body unchanged when there is no override or the body is not a
 * plain object. Never mutates the input body.
 */
export function mergeParamOverrideIntoBody(
  body: Record<string, unknown>,
  paramOverride: string | null | undefined,
): Record<string, unknown> {
  if (!paramOverride) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;

  let override: unknown;
  try {
    override = JSON.parse(paramOverride);
  } catch {
    return body;
  }
  if (!override || typeof override !== 'object' || Array.isArray(override)) return body;

  return { ...body, ...(override as Record<string, unknown>) };
}
