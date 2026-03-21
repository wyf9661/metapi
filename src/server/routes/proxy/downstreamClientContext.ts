import { extractClaudeCodeSessionId as extractClaudeCodeSessionIdViaProfile } from '../../proxy-core/cliProfiles/claudeCodeProfile.js';
import {
  detectCliProfile,
} from '../../proxy-core/cliProfiles/registry.js';
import { isCodexResponsesSurface as isCodexResponsesSurfaceViaProfile } from '../../proxy-core/cliProfiles/codexProfile.js';
import type { CliProfileId } from '../../proxy-core/cliProfiles/types.js';

export type DownstreamClientKind = CliProfileId;
export type DownstreamClientConfidence = 'exact' | 'heuristic';

export type DownstreamClientContext = {
  clientKind: DownstreamClientKind;
  sessionId?: string;
  traceHint?: string;
  clientAppId?: string;
  clientAppName?: string;
  clientConfidence?: DownstreamClientConfidence;
};

type NormalizedClientHeaders = Record<string, string[]>;

type DownstreamClientBodySummary = {
  topLevelKeys: string[];
  metadataUserId: string | null;
};

type DownstreamClientFingerprintInput = {
  downstreamPath: string;
  headers: NormalizedClientHeaders;
  bodySummary: DownstreamClientBodySummary;
};

type DownstreamClientFingerprintRule = {
  id: string;
  name: string;
  priority: number;
  match(input: DownstreamClientFingerprintInput): DownstreamClientConfidence | null;
};

type DownstreamProtocolClientApp = {
  clientAppId: string;
  clientAppName: string;
  clientConfidence: DownstreamClientConfidence;
};

type HeaderPrefixMatcherRule = {
  id: string;
  name: string;
  userAgentPrefixes?: string[];
  originatorPrefixes?: string[];
};

const codexOfficialClientAppRules: HeaderPrefixMatcherRule[] = [
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
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHeaderValues(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeHeaders(headers?: Record<string, unknown>): NormalizedClientHeaders {
  if (!headers) return {};

  const normalized: NormalizedClientHeaders = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    const values = normalizeHeaderValues(rawValue);
    if (values.length === 0) continue;
    normalized[key] = normalized[key]
      ? [...normalized[key], ...values]
      : values;
  }
  return normalized;
}

function headerEquals(headers: NormalizedClientHeaders, key: string, expected: string): boolean {
  const normalizedExpected = expected.trim().toLowerCase();
  return (headers[key.trim().toLowerCase()] || []).some((value) => value.trim().toLowerCase() === normalizedExpected);
}

function headerIncludes(headers: NormalizedClientHeaders, key: string, expectedFragment: string): boolean {
  const normalizedExpected = expectedFragment.trim().toLowerCase();
  return (headers[key.trim().toLowerCase()] || []).some((value) => value.trim().toLowerCase().includes(normalizedExpected));
}

function headerMatchesPrefixes(headers: NormalizedClientHeaders, key: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => headerIncludes(headers, key, prefix));
}

function normalizeClientDisplayName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= 120 ? trimmed : trimmed.slice(0, 120).trim() || null;
}

function normalizeClientAppId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function parseExplicitClientSelfReportValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      for (const key of ['client', 'name', 'app']) {
        const raw = parsed[key];
        if (typeof raw !== 'string') continue;
        const normalized = normalizeClientDisplayName(raw);
        if (normalized) return normalized;
      }
    }
  } catch {
    return normalizeClientDisplayName(trimmed);
  }

  return null;
}

function buildBodySummary(body: unknown): DownstreamClientBodySummary {
  if (!isRecord(body)) {
    return {
      topLevelKeys: [],
      metadataUserId: null,
    };
  }

  const metadataUserId = isRecord(body.metadata) && typeof body.metadata.user_id === 'string'
    ? body.metadata.user_id.trim() || null
    : null;

  return {
    topLevelKeys: Object.keys(body).sort((left, right) => left.localeCompare(right)),
    metadataUserId,
  };
}

const appFingerprintRegistry: DownstreamClientFingerprintRule[] = [
  {
    id: 'cherry_studio',
    name: 'Cherry Studio',
    priority: 100,
    match(input) {
      const hasTitle = headerEquals(input.headers, 'x-title', 'Cherry Studio');
      const hasReferer = headerEquals(input.headers, 'http-referer', 'https://cherry-ai.com')
        || headerEquals(input.headers, 'referer', 'https://cherry-ai.com');

      if (hasTitle && hasReferer) {
        return 'exact';
      }

      const weakSignals = [
        headerIncludes(input.headers, 'user-agent', 'cherrystudio'),
        headerIncludes(input.headers, 'x-title', 'cherry studio'),
        headerIncludes(input.headers, 'http-referer', 'cherry-ai.com'),
        headerIncludes(input.headers, 'referer', 'cherry-ai.com'),
      ];

      return weakSignals.some(Boolean) ? 'heuristic' : null;
    },
  },
];

function detectDownstreamClientFingerprint(input: {
  downstreamPath: string;
  headers?: Record<string, unknown>;
  body?: unknown;
}) {
  const fingerprintInput: DownstreamClientFingerprintInput = {
    downstreamPath: input.downstreamPath,
    headers: normalizeHeaders(input.headers),
    bodySummary: buildBodySummary(input.body),
  };

  let matchedRule: DownstreamClientFingerprintRule | null = null;
  let matchedConfidence: DownstreamClientConfidence | null = null;

  for (const rule of appFingerprintRegistry) {
    const confidence = rule.match(fingerprintInput);
    if (!confidence) continue;
    if (!matchedRule || rule.priority > matchedRule.priority) {
      matchedRule = rule;
      matchedConfidence = confidence;
    }
  }

  if (!matchedRule || !matchedConfidence) {
    return null;
  }

  return {
    clientAppId: matchedRule.id,
    clientAppName: matchedRule.name,
    clientConfidence: matchedConfidence,
  };
}

function detectExplicitClientSelfReport(headers: NormalizedClientHeaders): DownstreamProtocolClientApp | null {
  for (const value of headers['x-openai-client-user-agent'] || []) {
    const clientAppName = parseExplicitClientSelfReportValue(value);
    if (!clientAppName) continue;
    return {
      clientAppId: normalizeClientAppId(clientAppName) || 'self_reported_client',
      clientAppName,
      clientConfidence: 'exact',
    };
  }

  for (const value of headers['user-agent'] || []) {
    const normalized = value.trim().toLowerCase();
    if (!normalized.startsWith('openclaw/')) continue;
    return {
      clientAppId: 'openclaw',
      clientAppName: 'OpenClaw',
      clientConfidence: 'exact',
    };
  }

  return null;
}

function detectCodexOfficialClientApp(headers: NormalizedClientHeaders): DownstreamProtocolClientApp | null {
  for (const rule of codexOfficialClientAppRules) {
    const matchesOriginator = Array.isArray(rule.originatorPrefixes)
      && headerMatchesPrefixes(headers, 'originator', rule.originatorPrefixes);
    const matchesUserAgent = Array.isArray(rule.userAgentPrefixes)
      && headerMatchesPrefixes(headers, 'user-agent', rule.userAgentPrefixes);

    if (!matchesOriginator && !matchesUserAgent) continue;

    return {
      clientAppId: rule.id,
      clientAppName: rule.name,
      clientConfidence: 'exact',
    };
  }

  return null;
}

function detectProtocolClientApp(input: {
  clientKind: DownstreamClientKind;
  headers?: Record<string, unknown>;
}): DownstreamProtocolClientApp | null {
  switch (input.clientKind) {
    case 'claude_code':
      return {
        clientAppId: 'claude_code',
        clientAppName: 'Claude Code',
        clientConfidence: 'exact',
      };
    case 'gemini_cli':
      return {
        clientAppId: 'gemini_cli',
        clientAppName: 'Gemini CLI',
        clientConfidence: 'exact',
      };
    case 'codex': {
      const headers = normalizeHeaders(input.headers);
      return detectCodexOfficialClientApp(headers) || {
        clientAppId: 'codex',
        clientAppName: 'Codex',
        clientConfidence: 'heuristic',
      };
    }
    default:
      return null;
  }
}

export function isCodexResponsesSurface(headers?: Record<string, unknown>): boolean {
  return isCodexResponsesSurfaceViaProfile(headers);
}

export function extractClaudeCodeSessionId(userId: string): string | null {
  return extractClaudeCodeSessionIdViaProfile(userId);
}

export function detectDownstreamClientContext(input: {
  downstreamPath: string;
  headers?: Record<string, unknown>;
  body?: unknown;
}): DownstreamClientContext {
  const detected = detectCliProfile(input);
  const normalizedHeaders = normalizeHeaders(input.headers);
  const explicitSelfReport = detectExplicitClientSelfReport(normalizedHeaders);
  const fingerprint = detectDownstreamClientFingerprint(input);
  const protocolClientApp = fingerprint || explicitSelfReport ? null : detectProtocolClientApp({
    clientKind: detected.id,
    headers: input.headers,
  });
  return {
    clientKind: detected.id,
    ...(detected.sessionId ? { sessionId: detected.sessionId } : {}),
    ...(detected.traceHint ? { traceHint: detected.traceHint } : {}),
    ...(explicitSelfReport || fingerprint || protocolClientApp || {}),
  };
}
