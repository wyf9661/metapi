import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The usage log shows the reasoning effort a downstream client asked for, but
 * the log writers live in several route files that only receive the values they
 * already pass along. Rather than threading a new parameter through every
 * `logProxy` helper and call site, the proxy router captures the effort once per
 * request and the log store reads it from the async context.
 */
const reasoningEffortContext = new AsyncLocalStorage<string | null>();

/** Upstreams invent effort names (`low`, `medium`, `high`, `minimal`, `xhigh`);
 *  the log only ever displays the string, so keep it verbatim but bounded. */
export function normalizeReasoningEffort(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
}

/**
 * Pull the effort out of a downstream request body:
 * - chat/completions and most OpenAI-compatible clients: `reasoning_effort`
 * - Responses API: `reasoning: { effort }` (and `reasoning_effort` when sent)
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

  return null;
}

/** Called from the proxy router's per-request hook. */
export function setCurrentReasoningEffort(effort: string | null): void {
  reasoningEffortContext.enterWith(effort);
}

export function getCurrentReasoningEffort(): string | null {
  return reasoningEffortContext.getStore() ?? null;
}
