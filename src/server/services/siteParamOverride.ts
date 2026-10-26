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
 *
 * Session placeholder (borrowed from magpie's provider extraBody): a string
 * value may contain `${sessionId}`, replaced with the conversation's id. A
 * fixed `prompt_cache_key` puts every conversation on one cache key; the id
 * has to follow the conversation instead. The id comes from the caller when
 * it has one (a CLI profile's session header, say), otherwise it is derived
 * from the conversation's first user message, so every turn of the same
 * conversation gets the same key. When neither is available the override key
 * is dropped rather than sending the literal placeholder upstream.
 */
import { createHash } from 'node:crypto';

const MAX_PARAM_OVERRIDE_LENGTH = 4096;

/** Written in a string value to mean "the conversation's id". */
export const SESSION_PLACEHOLDER = '${sessionId}';

export type ParamOverrideContext = {
  /** Conversation id from the request (a CLI profile's session header, etc.). */
  sessionId?: string | null;
};

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

/** Text of a message's `content`, which may be a string or a parts array. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (part && typeof part === 'object') {
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

/** The conversation's first user message, across the supported surfaces. */
function firstUserText(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const entry = message as Record<string, unknown>;
      if (entry.role !== 'user') continue;
      const text = contentText(entry.content);
      if (text.trim()) return text;
    }
  }

  // OpenAI Responses: `input` is a string or a list of items.
  const input = body.input;
  if (typeof input === 'string' && input.trim()) return input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      if (entry.role !== undefined && entry.role !== 'user') continue;
      const text = contentText(entry.content);
      if (text.trim()) return text;
    }
  }

  // Gemini: `contents` carries `parts: [{ text }]`.
  const contents = body.contents;
  if (Array.isArray(contents)) {
    for (const item of contents) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      if (entry.role !== 'user') continue;
      const text = contentText(entry.parts);
      if (text.trim()) return text;
    }
  }

  // Completions: a bare prompt.
  const prompt = body.prompt;
  if (typeof prompt === 'string' && prompt.trim()) return prompt;

  return '';
}

/**
 * Stable id for a conversation whose caller did not name a session: a digest
 * of its first user message, identical for every turn of that conversation.
 */
function deriveSessionId(body: Record<string, unknown>): string {
  const text = firstUserText(body);
  if (!text) return '';
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(SESSION_PLACEHOLDER);
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasPlaceholder);
  }
  return false;
}

/**
 * Replace `${sessionId}` in every string of `value`. Returns `null` when a
 * placeholder had no id to resolve to; the caller then drops the key.
 */
function substitute(value: unknown, sessionId: string): unknown | null {
  if (typeof value === 'string') {
    if (!value.includes(SESSION_PLACEHOLDER)) return value;
    if (!sessionId) return null;
    return value.split(SESSION_PLACEHOLDER).join(sessionId);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const replaced = substitute(item, sessionId);
      if (replaced === null) return null;
      out.push(replaced);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const replaced = substitute(item, sessionId);
      if (replaced === null) return null;
      out[key] = replaced;
    }
    return out;
  }
  return value;
}

/**
 * Merge the site's param_override JSON into an outbound JSON request body.
 * Returns the body unchanged when there is no override or the body is not a
 * plain object. Never mutates the input body.
 */
export function mergeParamOverrideIntoBody(
  body: Record<string, unknown>,
  paramOverride: string | null | undefined,
  context: ParamOverrideContext = {},
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

  const entries = Object.entries(override as Record<string, unknown>);
  const needsSession = entries.some(([, value]) => hasPlaceholder(value));
  const sessionId = needsSession
    ? (context.sessionId?.trim() || deriveSessionId(body))
    : '';

  const merged: Record<string, unknown> = { ...body };
  for (const [key, value] of entries) {
    if (!needsSession) {
      merged[key] = value;
      continue;
    }
    const replaced = substitute(value, sessionId);
    if (replaced === null) continue; // unresolved placeholder: drop this key
    merged[key] = replaced;
  }
  return merged;
}
