import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The usage log shows the model the upstream *reported* serving, which is the
 * only evidence of what actually answered: relays silently swap aliases
 * (`deepseek-v4.1-flash` → `deepseek-v4.1-flash-1017`) and renames models
 * (`minimax-m3.1-flash` → `MiniMax-M3.1-Flash`). Kept in the async context
 * because every surface already funnels its upstream payload through
 * `parseProxyUsage`, while the log writer sits in another module.
 */
const responseModelContext = new AsyncLocalStorage<string | null>();

/**
 * Pull the model out of an upstream payload. Covers the four shapes that reach
 * the proxy: chat/completions (`model`), Anthropic messages (`message_start` →
 * `message.model`), Responses (`response.created`/`completed` → `response.model`)
 * and Gemini native (`modelVersion`).
 */
export function readResponseModel(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  for (const value of [
    record.model,
    record.modelVersion,
    (record.message as Record<string, unknown> | undefined)?.model,
    (record.response as Record<string, unknown> | undefined)?.model,
  ]) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
  }

  return null;
}

/** Called for every upstream payload; the last model reported wins. */
export function captureUpstreamResponseModel(payload: unknown): void {
  const model = readResponseModel(payload);
  if (model) responseModelContext.enterWith(model);
}

/**
 * Clear the slot at the start of each request. Without this a request whose
 * upstream never reports a model would inherit the previous request's value on
 * a reused execution context.
 */
export function setUpstreamResponseModel(model: string | null): void {
  responseModelContext.enterWith(model);
}

export function getUpstreamResponseModel(): string | null {
  return responseModelContext.getStore() ?? null;
}
