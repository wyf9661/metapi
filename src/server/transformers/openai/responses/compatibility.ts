import {
  normalizeResponsesInputForCompatibility,
  normalizeResponsesMessageContent,
  normalizeResponsesMessageItem,
} from './normalization.js';
import {
  convertOpenAiBodyToResponsesBody,
  sanitizeResponsesBodyForProxy,
} from './conversion.js';
import {
  hasEndpointMismatchHint,
  inferRequiredEndpointFromProtocolError,
} from '../../shared/endpointCompatibility.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildResponsesCompatibilityBodies(
  body: Record<string, unknown>,
  options?: {
    sitePlatform?: string;
  },
): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const useSemanticDedupe = asTrimmedString(options?.sitePlatform).toLowerCase() === 'sub2api';
  try {
    const originalKey = useSemanticDedupe
      ? fingerprintCompatibilityValue(body)
      : JSON.stringify(body);
    if (originalKey) seen.add(originalKey);
  } catch {
    // ignore non-serializable bodies
  }

  const push = (next: Record<string, unknown> | null) => {
    if (!next) return;
    let key = '';
    try {
      key = useSemanticDedupe
        ? fingerprintCompatibilityValue(next)
        : JSON.stringify(next);
    } catch {
      return;
    }
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(next);
  };

  push(stripResponsesMetadata(body));
  const coreModel = typeof body.model === 'string' ? body.model.trim() : '';
  if (coreModel && body.input !== undefined) {
    const richCandidate: Record<string, unknown> = {
      model: coreModel,
      input: body.input,
      stream: body.stream === true,
    };
    const maxOutputTokens = toFiniteNumber(body.max_output_tokens);
    if (maxOutputTokens !== null && maxOutputTokens > 0) {
      richCandidate.max_output_tokens = Math.trunc(maxOutputTokens);
    }
    const temperature = toFiniteNumber(body.temperature);
    if (temperature !== null) richCandidate.temperature = temperature;
    const topP = toFiniteNumber(body.top_p);
    if (topP !== null) richCandidate.top_p = topP;
    const instructions = getExplicitResponsesInstructions(body);
    if (instructions !== null) richCandidate.instructions = instructions;

    const passthroughFields = [
      'tools',
      'tool_choice',
      'parallel_tool_calls',
      'include',
      'reasoning',
      'previous_response_id',
      'truncation',
      'text',
      'service_tier',
      'safety_identifier',
      'max_tool_calls',
      'prompt_cache_key',
      'prompt_cache_retention',
      'background',
      'top_logprobs',
    ] as const;
    const normalizedSitePlatform = asTrimmedString(options?.sitePlatform).toLowerCase();
    if (normalizedSitePlatform === 'sub2api' && body.store !== undefined) {
      richCandidate.store = cloneJsonValue(body.store);
    }
    for (const key of passthroughFields) {
      if (body[key] === undefined) continue;
      richCandidate[key] = cloneJsonValue(body[key]);
    }
    push(richCandidate);
  }
  if (!shouldPreserveResponsesCompatibilitySemantics(options?.sitePlatform, body)) {
    push(buildStrictResponsesBody(body));
  }
  return candidates;
}

export function buildResponsesCompatibilityHeaderCandidates(
  headers: Record<string, string>,
  stream: boolean,
  options?: {
    sitePlatform?: string;
  },
): Record<string, string>[] {
  const candidates: Record<string, string>[] = [];
  const seen = new Set<string>();
  const push = (next: Record<string, string>) => {
    const normalizedEntries = Object.entries(next)
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([key, value]) => [key.toLowerCase(), value] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify(normalizedEntries);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(Object.fromEntries(normalizedEntries));
  };

  push(headers);

  const normalizedSitePlatform = asTrimmedString(options?.sitePlatform).toLowerCase();
  if (normalizedSitePlatform === 'sub2api') {
    push(buildSub2ApiResponsesCompatibilityHeaders(headers, stream));
    return candidates;
  }

  const minimal: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (
      key === 'authorization'
      || key === 'x-api-key'
      || key === 'content-type'
      || key === 'accept'
    ) {
      minimal[key] = rawValue;
    }
  }
  if (!minimal['content-type']) minimal['content-type'] = 'application/json';
  if (stream && !minimal.accept) minimal.accept = 'text/event-stream';
  push(minimal);

  return candidates;
}

export function shouldRetryResponsesCompatibility(input: {
  endpoint: string;
  status: number;
  rawErrText: string;
  body: Record<string, unknown>;
}): boolean {
  if (input.endpoint !== 'responses') return false;
  if (input.status !== 400) return false;
  const parsedError = parseUpstreamErrorShape(input.rawErrText);
  const type = parsedError.type.trim().toLowerCase();
  const code = parsedError.code.trim().toLowerCase();
  const message = parsedError.message.trim().toLowerCase();
  const compact = `${type} ${code} ${message}`.trim();
  const rawCompact = (input.rawErrText || '').toLowerCase();
  const requiredEndpoint = inferRequiredEndpointFromProtocolError(input.rawErrText);

  if (
    compact.includes('invalid_api_key')
    || compact.includes('authentication')
    || compact.includes('unauthorized')
    || compact.includes('forbidden')
    || compact.includes('insufficient_quota')
    || compact.includes('rate_limit')
  ) {
    return false;
  }

  const hasCompatibilityHint = (
    compact.includes('unsupported')
    || compact.includes('not supported')
    || compact.includes('application/json')
    || compact.includes('content-type')
    || compact.includes('request validation failed')
    || requiredEndpoint !== null
    || hasEndpointMismatchHint(input.rawErrText)
    || compact.includes('invalid_request_error')
    || compact.includes('bad_response_status_code')
    || compact.includes('openai_error')
    || compact.includes('unsupported legacy protocol')
  );
  if (hasCompatibilityHint) return true;

  const compatibilityCandidates = buildResponsesCompatibilityBodies(input.body);
  if (compatibilityCandidates.length > 0) {
    if (type === 'upstream_error' || code === 'upstream_error') return true;
    if (message === 'upstream_error' || message === 'upstream request failed') return true;
    if (rawCompact.includes('upstream_error')) return true;
    if (compact.length > 0) return true;
  }

  return false;
}

export function shouldDowngradeResponsesChatToMessages(
  endpointPath: string,
  status: number,
  upstreamErrorText: string,
): boolean {
  if (!endpointPath.includes('/chat/completions')) return false;
  if (status < 400 || status >= 500) return false;
  return inferRequiredEndpointFromProtocolError(upstreamErrorText) === 'messages';
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    ) as T;
  }
  return value;
}

function fingerprintCompatibilityValue(value: unknown): string {
  if (value === undefined) return '__undefined__';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => fingerprintCompatibilityValue(item)).join(',')}]`;
  }
  const entries = Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${fingerprintCompatibilityValue(item)}`);
  return `{${entries.join(',')}}`;
}

function parseUpstreamErrorShape(rawText: string): {
  type: string;
  code: string;
  message: string;
} {
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const error = (parsed.error && typeof parsed.error === 'object')
      ? parsed.error as Record<string, unknown>
      : parsed;
    return {
      type: typeof error.type === 'string' ? error.type.trim().toLowerCase() : '',
      code: typeof error.code === 'string' ? error.code.trim().toLowerCase() : '',
      message: typeof error.message === 'string' ? error.message.trim() : '',
    };
  } catch {
    return { type: '', code: '', message: '' };
  }
}

function getExplicitResponsesInstructions(body: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(body, 'instructions')) return null;
  return typeof body.instructions === 'string' ? body.instructions.trim() : '';
}

function shouldPreserveResponsesCompatibilitySemantics(
  sitePlatform: string | undefined,
  body: Record<string, unknown>,
): boolean {
  if (asTrimmedString(sitePlatform).toLowerCase() !== 'sub2api') return false;
  return [
    'store',
    'include',
    'reasoning',
    'previous_response_id',
    'truncation',
    'text',
    'service_tier',
    'safety_identifier',
    'max_tool_calls',
    'prompt_cache_key',
    'prompt_cache_retention',
    'background',
    'top_logprobs',
  ].some((key) => body[key] !== undefined);
}

const SUB2API_RESPONSES_COMPATIBILITY_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'conversation-id',
  'conversation_id',
  'openai-beta',
  'originator',
  'session-id',
  'session_id',
  'user-agent',
  'x-api-key',
  'x-codex-turn-metadata',
  'x-codex-turn-state',
]);

function buildSub2ApiResponsesCompatibilityHeaders(
  headers: Record<string, string>,
  stream: boolean,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (!SUB2API_RESPONSES_COMPATIBILITY_HEADER_ALLOWLIST.has(key)) continue;
    next[key] = rawValue;
  }
  if (!next['content-type']) next['content-type'] = 'application/json';
  if (stream && !next.accept) next.accept = 'text/event-stream';
  return next;
}

function stripResponsesMetadata(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!Object.prototype.hasOwnProperty.call(body, 'metadata')) return null;
  const next = { ...body };
  delete next.metadata;
  return next;
}

function buildStrictResponsesBody(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) return null;
  if (body.input === undefined) return null;

  const explicitInstructions = getExplicitResponsesInstructions(body);

  return {
    model,
    input: body.input,
    stream: body.stream === true,
    ...(body.tools !== undefined ? { tools: cloneJsonValue(body.tools) } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: cloneJsonValue(body.tool_choice) } : {}),
    ...(explicitInstructions !== null
      ? { instructions: explicitInstructions }
      : {}),
  };
}

export {
  convertOpenAiBodyToResponsesBody,
  normalizeResponsesInputForCompatibility,
  normalizeResponsesMessageContent,
  normalizeResponsesMessageItem,
  sanitizeResponsesBodyForProxy,
};
