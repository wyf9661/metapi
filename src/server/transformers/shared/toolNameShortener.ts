const TOOL_NAME_LIMIT = 64;
const MCP_PREFIX = 'mcp__';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeToolName(name: string): string {
  const trimmed = asTrimmedString(name);
  const normalized = trimmed
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'tool';
}

export function shortenToolNameIfNeeded(name: string): string {
  const normalized = normalizeToolName(name);
  if (normalized.length <= TOOL_NAME_LIMIT) return normalized;
  if (normalized.startsWith(MCP_PREFIX)) {
    const lastSeparator = normalized.lastIndexOf('__');
    if (lastSeparator > 0) {
      const candidate = `${MCP_PREFIX}${normalized.slice(lastSeparator + 2)}`;
      return candidate.length > TOOL_NAME_LIMIT ? candidate.slice(0, TOOL_NAME_LIMIT) : candidate;
    }
  }
  return normalized.slice(0, TOOL_NAME_LIMIT);
}

export function buildShortToolNameMap(names: string[]): Record<string, string> {
  const uniqueNames = Array.from(new Set(
    names
      .map((name) => asTrimmedString(name))
      .filter((name) => name.length > 0),
  ));
  const used = new Set<string>();
  const mapping: Record<string, string> = {};

  for (const name of uniqueNames) {
    const base = shortenToolNameIfNeeded(name);
    let candidate = base;
    let suffixIndex = 1;
    while (used.has(candidate)) {
      const suffix = `_${suffixIndex}`;
      const allowedLength = Math.max(0, TOOL_NAME_LIMIT - suffix.length);
      candidate = `${base.slice(0, allowedLength)}${suffix}`;
      suffixIndex += 1;
    }
    used.add(candidate);
    mapping[name] = candidate;
  }

  return mapping;
}

export function getShortToolName(name: string, mapping: Record<string, string>): string {
  const trimmed = asTrimmedString(name);
  return mapping[trimmed] || shortenToolNameIfNeeded(trimmed);
}
