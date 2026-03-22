import type { CliProfileDefinition, DetectCliProfileInput } from './types.js';

type CodexOfficialClientApp = {
  clientAppId: string;
  clientAppName: string;
};

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

const CODEX_OFFICIAL_CLIENT_APP_RULES = [
  {
    id: 'codex_cli_rs',
    name: 'Codex CLI',
    userAgentPrefixes: ['codex_cli_rs/'],
    originatorPrefixes: ['codex_cli_rs'],
  },
  {
    id: 'codex_vscode',
    name: 'Codex VSCode',
    userAgentPrefixes: ['codex_vscode/'],
    originatorPrefixes: ['codex_vscode'],
  },
  {
    id: 'codex_app',
    name: 'Codex App',
    userAgentPrefixes: ['codex_app/'],
    originatorPrefixes: ['codex_app'],
  },
  {
    id: 'codex_chatgpt_desktop',
    name: 'Codex Desktop',
    userAgentPrefixes: ['codex_chatgpt_desktop/', 'codex desktop/'],
    originatorPrefixes: ['codex_chatgpt_desktop', 'codex desktop'],
  },
  {
    id: 'codex_atlas',
    name: 'Codex Atlas',
    userAgentPrefixes: ['codex_atlas/'],
    originatorPrefixes: ['codex_atlas'],
  },
  {
    id: 'codex_exec',
    name: 'Codex Exec',
    userAgentPrefixes: ['codex_exec/'],
    originatorPrefixes: ['codex_exec'],
  },
  {
    id: 'codex_sdk_ts',
    name: 'Codex SDK TS',
    userAgentPrefixes: ['codex_sdk_ts/'],
    originatorPrefixes: ['codex_sdk_ts'],
  },
] as const;

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

export function detectCodexOfficialClientApp(
  headers?: Record<string, unknown>,
): CodexOfficialClientApp | null {
  for (const rule of CODEX_OFFICIAL_CLIENT_APP_RULES) {
    const matchesOriginator = Array.isArray(rule.originatorPrefixes)
      && matchesHeaderPrefixes(getHeaderValue(headers, 'originator'), [...rule.originatorPrefixes]);
    const matchesUserAgent = Array.isArray(rule.userAgentPrefixes)
      && matchesHeaderPrefixes(getHeaderValue(headers, 'user-agent'), [...rule.userAgentPrefixes]);
    if (!matchesOriginator && !matchesUserAgent) continue;
    return {
      clientAppId: rule.id,
      clientAppName: rule.name,
    };
  }
  return null;
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
