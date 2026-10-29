/**
 * Canonical finish-reason vocabulary, shared by every protocol edge.
 *
 * Before this module each edge carried its own word list and its own fuzzy matching
 * (`value.includes('max')`, `value.includes('tool')`), so:
 *   - `content_filter` / `safety` / `refusal` matched nothing and fell through to a
 *     `|| 'stop'` default: a blocked generation looked like a clean finish to billing,
 *     health sampling and the client;
 *   - `nomatch` matched `includes('tool')` and `max_tool_calls` matched `includes('max')`.
 *
 * The fix is a single exact-match table (no substring matching) plus one projection per
 * wire format. Unknown values stay `null` so the caller keeps its existing default.
 */

export const CANONICAL_FINISH_REASONS = [
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'error',
] as const;

export type CanonicalFinishReason = (typeof CANONICAL_FINISH_REASONS)[number];

/**
 * Exact upstream spellings -> canonical value. Keys are already normalised
 * (lowercase, `-`/space -> `_`), see `normalizeFinishReason`.
 */
const FINISH_REASON_TABLE: Record<string, CanonicalFinishReason> = {
  // clean finishes
  stop: 'stop',
  end: 'stop',
  eos: 'stop',
  finished: 'stop',
  complete: 'stop',
  completed: 'stop',
  end_turn: 'stop',
  stop_sequence: 'stop',
  pause_turn: 'stop', // Anthropic: server-tool loop paused, not a failure
  // output budget
  length: 'length',
  max_tokens: 'length',
  max_output_tokens: 'length',
  max_tokens_exceeded: 'length',
  max_completion_tokens: 'length',
  token_limit: 'length',
  incomplete: 'length',
  // tool use
  tool_use: 'tool_calls',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  // safety / policy stops
  content_filter: 'content_filter',
  safety: 'content_filter', // Gemini
  recitation: 'content_filter', // Gemini
  blocklist: 'content_filter', // Gemini
  prohibited_content: 'content_filter', // Gemini
  spii: 'content_filter', // Gemini
  image_safety: 'content_filter', // Gemini
  language: 'content_filter', // Gemini
  refusal: 'content_filter', // Anthropic
  // failures
  error: 'error',
  failed: 'error',
  failure: 'error',
  cancelled: 'error',
  canceled: 'error',
  aborted: 'error',
  timeout: 'error',
  server_error: 'error',
  malformed_function_call: 'error', // Gemini
  unexpected_tool_call: 'error', // Gemini
};

/**
 * Map any upstream finish reason to the canonical set; `null` for an unknown or empty
 * value (callers keep their own default). Matching is exact — substring heuristics are
 * what turned `nomatch` into `tool_calls`.
 */
export function normalizeFinishReason(raw: unknown): CanonicalFinishReason | null {
  if (typeof raw !== 'string') return null;
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!value) return null;
  return FINISH_REASON_TABLE[value] ?? null;
}

/** True when the upstream reported a failed generation rather than an ending. */
export function isErrorFinish(raw: unknown): boolean {
  return normalizeFinishReason(raw) === 'error';
}

/**
 * Projection for OpenAI chat.completions / responses, whose `finish_reason` enum has no
 * "error" member. An errored stream must therefore be surfaced as an SSE error frame by
 * the caller; the value here only keeps the field well-formed.
 */
export function toOpenAiFinishReason(raw: unknown): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  const canonical = normalizeFinishReason(raw);
  if (canonical === 'length' || canonical === 'tool_calls' || canonical === 'content_filter') {
    return canonical;
  }
  return 'stop';
}

/**
 * Projection for Anthropic messages. `refusal` is the enum member for a safety stop;
 * Anthropic has no error stop_reason, so an errored stream needs an `event: error`
 * frame emitted by the caller (see `buildDoneEvents`).
 */
export function toAnthropicStopReason(raw: unknown): 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal' {
  const canonical = normalizeFinishReason(raw);
  if (canonical === 'length') return 'max_tokens';
  if (canonical === 'tool_calls') return 'tool_use';
  if (canonical === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** Projection for Gemini generateContent candidate.finishReason. */
export function toGeminiFinishReason(raw: unknown): 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'OTHER' {
  const canonical = normalizeFinishReason(raw);
  if (canonical === 'length') return 'MAX_TOKENS';
  if (canonical === 'content_filter') return 'SAFETY';
  if (canonical === 'error') return 'OTHER';
  return 'STOP';
}
