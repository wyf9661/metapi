import type { DownstreamFormat } from './normalized.js';

export type CompatibilityEndpoint = 'chat' | 'messages' | 'responses';
export type CompatibilityEndpointPreference = DownstreamFormat | 'responses';

type ParsedEndpointErrorShape = {
  code: string;
  message: string;
  text: string;
  type: string;
};

type PreferResponsesAfterLegacyChatErrorInput = {
  status: number;
  upstreamErrorText?: string | null;
  downstreamFormat: CompatibilityEndpointPreference;
  sitePlatform?: string | null;
  modelName?: string | null;
  requestedModelHint?: string | null;
  currentEndpoint?: CompatibilityEndpoint | null;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatformName(platform: unknown): string {
  return asTrimmedString(platform).toLowerCase();
}

function isClaudeFamilyModel(modelName: string): boolean {
  const normalized = asTrimmedString(modelName).toLowerCase();
  if (!normalized) return false;
  return normalized === 'claude' || normalized.startsWith('claude-') || normalized.includes('claude');
}

function headerValueToString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }

  return null;
}

function normalizeHeaderMap(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    const value = headerValueToString(rawValue);
    if (!value) continue;
    normalized[key] = value;
  }
  return normalized;
}

function parseEndpointErrorShape(upstreamErrorText?: string | null): ParsedEndpointErrorShape {
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) {
    return {
      code: '',
      message: '',
      text: '',
      type: '',
    };
  }

  try {
    const parsed = JSON.parse(upstreamErrorText || '{}') as Record<string, unknown>;
    const error = (parsed.error && typeof parsed.error === 'object')
      ? parsed.error as Record<string, unknown>
      : parsed;
    return {
      code: asTrimmedString(error.code).toLowerCase(),
      message: asTrimmedString(error.message).toLowerCase(),
      text,
      type: asTrimmedString(error.type).toLowerCase(),
    };
  } catch {
    return {
      code: '',
      message: '',
      text,
      type: '',
    };
  }
}

function inferEndpointMentionFromText(text: string): CompatibilityEndpoint | null {
  if (!text) return null;
  if (text.includes('/v1/responses') || /\bresponses\b/.test(text)) return 'responses';
  if (text.includes('/v1/messages') || /\bmessages\b/.test(text)) return 'messages';
  if (text.includes('/v1/chat/completions') || /\bchat(?:\/completions)?\b/.test(text)) return 'chat';
  return null;
}

export function buildMinimalJsonHeadersForCompatibility(input: {
  headers: Record<string, string>;
  endpoint: CompatibilityEndpoint;
  stream: boolean;
}): Record<string, string> {
  const source = normalizeHeaderMap(input.headers);
  const minimal: Record<string, string> = {};

  if (source.authorization) minimal.authorization = source.authorization;
  if (source['x-api-key']) minimal['x-api-key'] = source['x-api-key'];

  if (input.endpoint === 'messages') {
    for (const [key, value] of Object.entries(source)) {
      if (!key.startsWith('anthropic-')) continue;
      minimal[key] = value;
    }
    if (!minimal['anthropic-version']) {
      minimal['anthropic-version'] = '2023-06-01';
    }
  }

  minimal['content-type'] = 'application/json';
  minimal.accept = input.stream ? 'text/event-stream' : 'application/json';
  return minimal;
}

export function isUnsupportedMediaTypeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  if (status !== 400 && status !== 415) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) return status === 415;

  return (
    text.includes('unsupported media type')
    || text.includes("only 'application/json' is allowed")
    || text.includes('only "application/json" is allowed')
    || text.includes('application/json')
    || text.includes('content-type')
  );
}

export function isEndpointDispatchDeniedError(status: number, upstreamErrorText?: string | null): boolean {
  if (status !== 403) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) return false;

  return (
    /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i.test(upstreamErrorText || '')
    || text.includes('dispatch denied')
  );
}

export function inferRequiredEndpointFromProtocolError(
  upstreamErrorText?: string | null,
): CompatibilityEndpoint | null {
  const parsed = parseEndpointErrorShape(upstreamErrorText);
  const combined = `${parsed.text}\n${parsed.message}`;
  if (!combined.trim()) return null;
  if (/messages\s+is\s+required/i.test(combined)) return 'messages';
  if (/input\s+is\s+required/i.test(combined)) return 'responses';
  return null;
}

export function inferSuggestedEndpointFromUpstreamError(
  upstreamErrorText?: string | null,
): CompatibilityEndpoint | null {
  const requiredEndpoint = inferRequiredEndpointFromProtocolError(upstreamErrorText);
  if (requiredEndpoint) return requiredEndpoint;

  const parsed = parseEndpointErrorShape(upstreamErrorText);
  return (
    inferEndpointMentionFromText(parsed.message)
    || inferEndpointMentionFromText(parsed.text)
  );
}

export function hasEndpointMismatchHint(upstreamErrorText?: string | null): boolean {
  const parsed = parseEndpointErrorShape(upstreamErrorText);
  if (!parsed.text) return false;

  const phrases = [
    'not found',
    'unknown endpoint',
    'unsupported endpoint',
    'unsupported path',
    'unrecognized request url',
    'no route matched',
    'does not exist',
    'invalid url',
  ];
  return phrases.some((phrase) => (
    parsed.text.includes(phrase) || parsed.message.includes(phrase)
  )) || inferSuggestedEndpointFromUpstreamError(upstreamErrorText) !== null;
}

export function promoteRequiredEndpointCandidateAfterProtocolError(
  endpointCandidates: CompatibilityEndpoint[],
  input: {
    currentEndpoint?: CompatibilityEndpoint | null;
    upstreamErrorText?: string | null;
  },
): void {
  const currentEndpoint = input.currentEndpoint ?? null;
  const requiredEndpoint = inferRequiredEndpointFromProtocolError(input.upstreamErrorText);
  if (!currentEndpoint || !requiredEndpoint || currentEndpoint === requiredEndpoint) return;

  const currentIndex = endpointCandidates.findIndex((endpoint) => endpoint === currentEndpoint);
  const requiredIndex = endpointCandidates.indexOf(requiredEndpoint);
  if (currentIndex < 0 || requiredIndex < 0 || requiredIndex <= currentIndex + 1) return;

  endpointCandidates.splice(requiredIndex, 1);
  endpointCandidates.splice(currentIndex + 1, 0, requiredEndpoint);
}

export function shouldPreferResponsesAfterLegacyChatError(
  input: PreferResponsesAfterLegacyChatErrorInput,
): boolean {
  if (input.status < 400) return false;
  if (input.downstreamFormat !== 'openai') return false;
  if (input.currentEndpoint !== 'chat') return false;

  const sitePlatform = normalizePlatformName(input.sitePlatform);
  if (sitePlatform === 'openai' || sitePlatform === 'claude' || sitePlatform === 'gemini' || sitePlatform === 'anyrouter') {
    return false;
  }

  const modelName = asTrimmedString(input.modelName);
  const requestedModelHint = asTrimmedString(input.requestedModelHint);
  if (isClaudeFamilyModel(modelName) || isClaudeFamilyModel(requestedModelHint)) {
    return false;
  }

  const text = (input.upstreamErrorText || '').toLowerCase();
  return (
    text.includes('unsupported legacy protocol')
    && text.includes('/v1/chat/completions')
    && text.includes('/v1/responses')
  );
}

export function promoteResponsesCandidateAfterLegacyChatError(
  endpointCandidates: CompatibilityEndpoint[],
  input: PreferResponsesAfterLegacyChatErrorInput,
): void {
  if (!shouldPreferResponsesAfterLegacyChatError(input)) return;

  const currentIndex = endpointCandidates.findIndex((endpoint) => endpoint === input.currentEndpoint);
  const responsesIndex = endpointCandidates.indexOf('responses');
  if (currentIndex < 0 || responsesIndex < 0 || responsesIndex <= currentIndex + 1) return;

  endpointCandidates.splice(responsesIndex, 1);
  endpointCandidates.splice(currentIndex + 1, 0, 'responses');
}

export function isEndpointDowngradeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  const parsed = parseEndpointErrorShape(upstreamErrorText);
  const text = parsed.text;
  if (status === 404 || status === 405 || status === 415 || status === 501) return true;
  if (!text) return false;
  const endpointMismatchHint = hasEndpointMismatchHint(upstreamErrorText);

  return (
    isEndpointDispatchDeniedError(status, upstreamErrorText)
    || text.includes('convert_request_failed')
    || text.includes('not found')
    || text.includes('unknown endpoint')
    || text.includes('unsupported endpoint')
    || text.includes('unsupported path')
    || text.includes('unrecognized request url')
    || text.includes('no route matched')
    || text.includes('does not exist')
    || (
      text.includes('openai_error')
      && endpointMismatchHint
    )
    || (
      text.includes('upstream_error')
      && endpointMismatchHint
    )
    || text.includes('bad_response_status_code')
    || text.includes('unsupported media type')
    || text.includes("only 'application/json' is allowed")
    || text.includes('only "application/json" is allowed')
    || (status === 400 && text.includes('unsupported'))
    || text.includes('not implemented')
    || text.includes('api not implemented')
    || text.includes('unsupported legacy protocol')
    || parsed.code === 'convert_request_failed'
    || parsed.code === 'not_found'
    || parsed.code === 'endpoint_not_found'
    || parsed.code === 'unknown_endpoint'
    || parsed.code === 'unsupported_endpoint'
    || parsed.code === 'bad_response_status_code'
    || (
      parsed.code === 'openai_error'
      && endpointMismatchHint
    )
    || (
      parsed.code === 'upstream_error'
      && endpointMismatchHint
    )
    || parsed.type === 'not_found_error'
    || parsed.type === 'invalid_request_error'
    || parsed.type === 'unsupported_endpoint'
    || parsed.type === 'unsupported_path'
    || parsed.type === 'bad_response_status_code'
    || (
      parsed.type === 'openai_error'
      && endpointMismatchHint
    )
    || (
      parsed.type === 'upstream_error'
      && endpointMismatchHint
    )
    || parsed.message.includes('unknown endpoint')
    || parsed.message.includes('unsupported endpoint')
    || parsed.message.includes('unsupported path')
    || parsed.message.includes('unrecognized request url')
    || parsed.message.includes('no route matched')
    || parsed.message.includes('does not exist')
    || parsed.message.includes('bad_response_status_code')
    || (
      parsed.message === 'openai_error'
      && endpointMismatchHint
    )
    || (
      parsed.message === 'upstream_error'
      && endpointMismatchHint
    )
    || parsed.message.includes('unsupported media type')
    || parsed.message.includes("only 'application/json' is allowed")
    || parsed.message.includes('only "application/json" is allowed')
    || (
      status === 400
      && parsed.code === 'invalid_request'
      && parsed.type === 'new_api_error'
      && (parsed.message.includes('claude code cli') || text.includes('claude code cli'))
    )
  );
}
