export type RequestOverrideRule =
  | { op: 'set' | 'set_if_absent'; path: string; value: unknown }
  | { op: 'delete'; path: string }
  | { op: 'rename' | 'copy'; from: string; to: string };

const MAX_RULES = 50;
const MAX_PATH_DEPTH = 8;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function pathSegments(path: string): string[] | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const segments = trimmed.split('.').map((part) => part.trim());
  if (segments.length > MAX_PATH_DEPTH || segments.some((part) => !part || FORBIDDEN_SEGMENTS.has(part))) return null;
  return segments;
}

function cloneValue(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneValue(item)]));
}

function readPath(body: Record<string, unknown>, path: string): { exists: boolean; value: unknown } {
  const segments = pathSegments(path);
  if (!segments) return { exists: false, value: undefined };
  let current: unknown = body;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { exists: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function writePath(body: Record<string, unknown>, path: string, value: unknown, onlyIfAbsent: boolean): void {
  const segments = pathSegments(path);
  if (!segments) return;
  let current = body;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  const finalSegment = segments[segments.length - 1] as string;
  if (!onlyIfAbsent || !Object.prototype.hasOwnProperty.call(current, finalSegment)) {
    current[finalSegment] = cloneValue(value);
  }
}

function deletePath(body: Record<string, unknown>, path: string): void {
  const segments = pathSegments(path);
  if (!segments) return;
  let current: unknown = body;
  for (const segment of segments.slice(0, -1)) {
    if (!current || typeof current !== 'object') return;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current && typeof current === 'object') delete (current as Record<string, unknown>)[segments[segments.length - 1] as string];
}

export function normalizeRequestOverrideRules(input: unknown): RequestOverrideRule[] {
  let raw: unknown = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  const rules: RequestOverrideRule[] = [];
  for (const item of raw.slice(0, MAX_RULES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const op = record.op;
    if (op === 'set' || op === 'set_if_absent') {
      if (typeof record.path === 'string' && pathSegments(record.path)) rules.push({ op, path: record.path.trim(), value: record.value });
    } else if (op === 'delete') {
      if (typeof record.path === 'string' && pathSegments(record.path)) rules.push({ op, path: record.path.trim() });
    } else if (op === 'rename' || op === 'copy') {
      if (typeof record.from === 'string' && typeof record.to === 'string' && pathSegments(record.from) && pathSegments(record.to)) {
        rules.push({ op, from: record.from.trim(), to: record.to.trim() });
      }
    }
  }
  return rules;
}

export function applyRequestOverrideRules(body: Record<string, unknown>, input: unknown): Record<string, unknown> {
  const result = cloneValue(body) as Record<string, unknown>;
  for (const rule of normalizeRequestOverrideRules(input)) {
    if (rule.op === 'set') writePath(result, rule.path, rule.value, false);
    else if (rule.op === 'set_if_absent') writePath(result, rule.path, rule.value, true);
    else if (rule.op === 'delete') deletePath(result, rule.path);
    else {
      const moveRule = rule as Extract<RequestOverrideRule, { op: 'rename' | 'copy' }>;
      const source = readPath(result, moveRule.from);
      if (!source.exists) continue;
      writePath(result, moveRule.to, source.value, false);
      if (moveRule.op === 'rename') deletePath(result, moveRule.from);
    }
  }
  return result;
}
