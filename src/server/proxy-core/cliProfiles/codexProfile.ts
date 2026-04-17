import type { CliProfileDefinition, DetectCliProfileInput } from './types.js';
import {
  detectCodexOfficialClientApp as detectCodexOfficialClientAppFromHeaders,
  isCodexOfficialClientHeaders,
} from '../../shared/codexClientFamily.js';

type CodexOfficialClientApp = {
  clientAppId: string;
  clientAppName: string;
};

function headerValueToStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) values.push(trimmed);
    }
    return values;
  }

  return [];
}

function headerValueToString(value: unknown): string | null {
  return headerValueToStrings(value)[0] || null;
}

function getHeaderValue(headers: Record<string, unknown> | undefined, targetKey: string): string | null {
  return getHeaderValues(headers, targetKey)[0] || null;
}

function getHeaderValues(headers: Record<string, unknown> | undefined, targetKey: string): string[] {
  if (!headers) return [];
  const normalizedTarget = targetKey.trim().toLowerCase();
  const values: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== normalizedTarget) continue;
    values.push(...headerValueToStrings(rawValue));
  }
  return values;
}

function hasHeaderPrefix(headers: Record<string, unknown> | undefined, prefix: string): boolean {
  if (!headers) return false;
  const normalizedPrefix = prefix.trim().toLowerCase();
  return Object.entries(headers).some(([rawKey, rawValue]) => {
    const key = rawKey.trim().toLowerCase();
    return key.startsWith(normalizedPrefix) && !!headerValueToString(rawValue);
  });
}

function isCodexPath(path: string): boolean {
  const normalizedPath = path.trim().toLowerCase();
  return normalizedPath === '/v1/responses'
    || normalizedPath.startsWith('/v1/responses/')
    || normalizedPath === '/v1/chat/completions';
}

export function detectCodexOfficialClientApp(
  headers?: Record<string, unknown>,
): CodexOfficialClientApp | null {
  const detected = detectCodexOfficialClientAppFromHeaders(headers);
  return detected
    ? {
      clientAppId: detected.clientAppId,
      clientAppName: detected.clientAppName,
    }
    : null;
}

export function isCodexResponsesSurface(headers?: Record<string, unknown>): boolean {
  return isCodexRequest({
    downstreamPath: '/v1/responses',
    headers,
  });
}

export function getCodexSessionId(headers?: Record<string, unknown>): string | null {
  return getHeaderValue(headers, 'session_id')
    || getHeaderValue(headers, 'session-id')
    || getHeaderValue(headers, 'conversation_id')
    || getHeaderValue(headers, 'conversation-id');
}

export function isCodexRequest(input: DetectCliProfileInput): boolean {
  if (!isCodexPath(input.downstreamPath)) return false;
  const headers = input.headers;
  if (!headers) return false;

  if (isCodexOfficialClientHeaders(headers)) return true;
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
    const clientApp = detectCodexOfficialClientApp(input.headers);
    return {
      id: 'codex',
      ...(sessionId ? { sessionId, traceHint: sessionId } : {}),
      ...(clientApp
        ? {
          clientAppId: clientApp.clientAppId,
          clientAppName: clientApp.clientAppName,
          clientConfidence: 'exact' as const,
        }
        : {
          clientAppId: 'codex',
          clientAppName: 'Codex',
          clientConfidence: 'heuristic' as const,
        }),
    };
  },
};
