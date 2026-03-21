const TOOL_NAME_LIMIT = 64;
const MCP_PREFIX = 'mcp__';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function shortenToolNameIfNeeded(name: string): string {
  const trimmed = asTrimmedString(name);
  if (trimmed.length <= TOOL_NAME_LIMIT) return trimmed;
  if (trimmed.startsWith(MCP_PREFIX)) {
    const lastSeparator = trimmed.lastIndexOf('__');
    if (lastSeparator > 0) {
      const candidate = `${MCP_PREFIX}${trimmed.slice(lastSeparator + 2)}`;
      return candidate.length > TOOL_NAME_LIMIT ? candidate.slice(0, TOOL_NAME_LIMIT) : candidate;
    }
  }
  return trimmed.slice(0, TOOL_NAME_LIMIT);
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
