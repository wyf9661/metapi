type CodexOfficialClientRule = {
  clientAppId: string;
  clientAppName: string;
  originator: string;
  userAgentPrefixes: readonly string[];
  originatorPrefixes: readonly string[];
};

export type CodexOfficialClientApp = Pick<
  CodexOfficialClientRule,
  'clientAppId' | 'clientAppName' | 'originator'
>;

const CODEX_OFFICIAL_CLIENT_RULES: readonly CodexOfficialClientRule[] = [
  {
    clientAppId: 'codex_cli_rs',
    clientAppName: 'Codex CLI',
    originator: 'codex_cli_rs',
    userAgentPrefixes: ['codex_cli_rs/'],
    originatorPrefixes: ['codex_cli_rs'],
  },
  {
    clientAppId: 'codex_vscode',
    clientAppName: 'Codex VSCode',
    originator: 'codex_vscode',
    userAgentPrefixes: ['codex_vscode/'],
    originatorPrefixes: ['codex_vscode'],
  },
  {
    clientAppId: 'codex_app',
    clientAppName: 'Codex App',
    originator: 'codex_app',
    userAgentPrefixes: ['codex_app/'],
    originatorPrefixes: ['codex_app'],
  },
  {
    clientAppId: 'codex_chatgpt_desktop',
    clientAppName: 'Codex Desktop',
    originator: 'codex_chatgpt_desktop',
    userAgentPrefixes: ['codex_chatgpt_desktop/', 'codex desktop/'],
    originatorPrefixes: ['codex_chatgpt_desktop', 'codex desktop'],
  },
  {
    clientAppId: 'codex_atlas',
    clientAppName: 'Codex Atlas',
    originator: 'codex_atlas',
    userAgentPrefixes: ['codex_atlas/'],
    originatorPrefixes: ['codex_atlas'],
  },
  {
    clientAppId: 'codex_exec',
    clientAppName: 'Codex Exec',
    originator: 'codex_exec',
    userAgentPrefixes: ['codex_exec/'],
    originatorPrefixes: ['codex_exec'],
  },
  {
    clientAppId: 'codex_sdk_ts',
    clientAppName: 'Codex SDK TS',
    originator: 'codex_sdk_ts',
    userAgentPrefixes: ['codex_sdk_ts/'],
    originatorPrefixes: ['codex_sdk_ts'],
  },
];

const CODEX_OFFICIAL_CLIENT_USER_AGENT_PREFIXES = [
  ...new Set(CODEX_OFFICIAL_CLIENT_RULES.flatMap((rule) => rule.userAgentPrefixes)),
  'codex ',
] as const;

const CODEX_OFFICIAL_CLIENT_ORIGINATOR_PREFIXES = [
  'codex_',
  'codex ',
] as const;

function normalizeHeaderValue(value: string): string {
  return value.trim().toLowerCase();
}

function headerValueToStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (!Array.isArray(value)) return [];

  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) values.push(trimmed);
  }
  return values;
}

function getHeaderValues(
  headers: Record<string, unknown> | undefined,
  targetKey: string,
): string[] {
  if (!headers) return [];
  const normalizedTarget = normalizeHeaderValue(targetKey);
  const values: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (normalizeHeaderValue(rawKey) !== normalizedTarget) continue;
    values.push(...headerValueToStrings(rawValue));
  }
  return values;
}

function matchesCodexClientPrefixes(
  value: string | string[] | null | undefined,
  prefixes: readonly string[],
): boolean {
  const normalizedValues = Array.isArray(value)
    ? value.map((item) => normalizeHeaderValue(item)).filter(Boolean)
    : (typeof value === 'string' ? [normalizeHeaderValue(value)] : []).filter(Boolean);
  if (normalizedValues.length <= 0) return false;

  return normalizedValues.some((normalizedValue) => prefixes.some((prefix) => {
    const normalizedPrefix = normalizeHeaderValue(prefix);
    return !!normalizedPrefix
      && (normalizedValue.startsWith(normalizedPrefix) || normalizedValue.includes(normalizedPrefix));
  }));
}

export function detectCodexOfficialClientApp(
  headers?: Record<string, unknown>,
): CodexOfficialClientApp | null {
  for (const rule of CODEX_OFFICIAL_CLIENT_RULES) {
    const matchesOriginator = matchesCodexClientPrefixes(
      getHeaderValues(headers, 'originator'),
      rule.originatorPrefixes,
    );
    const matchesUserAgent = matchesCodexClientPrefixes(
      getHeaderValues(headers, 'user-agent'),
      rule.userAgentPrefixes,
    );
    if (!matchesOriginator && !matchesUserAgent) continue;
    return {
      clientAppId: rule.clientAppId,
      clientAppName: rule.clientAppName,
      originator: rule.originator,
    };
  }
  return null;
}

export function inferCodexOfficialOriginator(
  headers?: Record<string, unknown>,
): string | null {
  return detectCodexOfficialClientApp(headers)?.originator || null;
}

export function isCodexOfficialClientHeaders(
  headers?: Record<string, unknown>,
): boolean {
  if (detectCodexOfficialClientApp(headers)) return true;
  return matchesCodexClientPrefixes(
    getHeaderValues(headers, 'originator'),
    CODEX_OFFICIAL_CLIENT_ORIGINATOR_PREFIXES,
  ) || matchesCodexClientPrefixes(
    getHeaderValues(headers, 'user-agent'),
    CODEX_OFFICIAL_CLIENT_USER_AGENT_PREFIXES,
  );
}
