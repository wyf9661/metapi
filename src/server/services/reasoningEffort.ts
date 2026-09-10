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
