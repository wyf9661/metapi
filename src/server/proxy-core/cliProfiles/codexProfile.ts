import type { CliProfileDefinition, DetectCliProfileInput } from './types.js';

const CODEX_OFFICIAL_CLIENT_USER_AGENT_PREFIXES = [
  'codex_cli_rs/',
  'codex_vscode/',
  'codex_app/',
  'codex_chatgpt_desktop/',
  'codex_atlas/',
  'codex_exec/',
  'codex_sdk_ts/',
  'codex ',
];

const CODEX_OFFICIAL_CLIENT_ORIGINATOR_PREFIXES = [
  'codex_',
  'codex ',
];

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

function getHeaderValue(headers: Record<string, unknown> | undefined, targetKey: string): string | null {
  if (!headers) return null;
  const normalizedTarget = targetKey.trim().toLowerCase();

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== normalizedTarget) continue;
    return headerValueToString(rawValue);
  }

  return null;
}

function hasHeaderPrefix(headers: Record<string, unknown> | undefined, prefix: string): boolean {
  if (!headers) return false;
  const normalizedPrefix = prefix.trim().toLowerCase();
  return Object.entries(headers).some(([rawKey, rawValue]) => {
    const key = rawKey.trim().toLowerCase();
    return key.startsWith(normalizedPrefix) && !!headerValueToString(rawValue);
  });
}

function matchesHeaderPrefixes(value: string | null, prefixes: string[]): boolean {
  const normalizedValue = value?.trim().toLowerCase() || '';
  if (!normalizedValue) return false;

  return prefixes.some((prefix) => {
    const normalizedPrefix = prefix.trim().toLowerCase();
    if (!normalizedPrefix) return false;
    return normalizedValue.startsWith(normalizedPrefix)
      || normalizedValue.includes(normalizedPrefix);
  });
}

function isCodexPath(path: string): boolean {
  const normalizedPath = path.trim().toLowerCase();
  return normalizedPath.startsWith('/v1/responses')
    || normalizedPath === '/v1/chat/completions'
    || normalizedPath.startsWith('/v1/messages');
}

export function isCodexResponsesSurface(headers?: Record<string, unknown>): boolean {
  return isCodexRequest({
    downstreamPath: '/v1/responses',
    headers,
  });
}

export function getCodexSessionId(headers?: Record<string, unknown>): string | null {
  return getHeaderValue(headers, 'session_id') || getHeaderValue(headers, 'session-id');
}

export function isCodexRequest(input: DetectCliProfileInput): boolean {
  if (!isCodexPath(input.downstreamPath)) return false;
  const headers = input.headers;
  if (!headers) return false;

  const originator = getHeaderValue(headers, 'originator');
  if (matchesHeaderPrefixes(originator, CODEX_OFFICIAL_CLIENT_ORIGINATOR_PREFIXES)) return true;
  if (matchesHeaderPrefixes(getHeaderValue(headers, 'user-agent'), CODEX_OFFICIAL_CLIENT_USER_AGENT_PREFIXES)) return true;
  if (getHeaderValue(headers, 'openai-beta')) return true;
  if (hasHeaderPrefix(headers, 'x-stainless-')) return true;
  if (getCodexSessionId(headers)) return true;
  if (getHeaderValue(headers, 'x-codex-turn-state')) return true;
  return false;
}

export const codexCliProfile: CliProfileDefinition = {
  id: 'codex',
  capabilities: {
    supportsResponsesCompact: true,
    supportsResponsesWebsocketIncremental: true,
    preservesContinuation: true,
    supportsCountTokens: false,
    echoesTurnState: true,
  },
  detect(input) {
    if (!isCodexRequest(input)) return null;

    const sessionId = getCodexSessionId(input.headers) || undefined;
    return {
      id: 'codex',
      ...(sessionId ? { sessionId, traceHint: sessionId } : {}),
    };
  },
};
