import { minimatch } from 'minimatch';

export type PayloadRuleModel = {
  name: string;
  protocol?: string;
};

export type PayloadValueRule = {
  models: PayloadRuleModel[];
  params: Record<string, unknown>;
};

export type PayloadFilterRule = {
  models: PayloadRuleModel[];
  params: string[];
};

export type PayloadRulesConfig = {
  default: PayloadValueRule[];
  defaultRaw: PayloadValueRule[];
  override: PayloadValueRule[];
  overrideRaw: PayloadValueRule[];
  filter: PayloadFilterRule[];
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

function toPathSegments(path: string): string[] {
  const normalized = asTrimmedString(path).replace(/^\.+/, '');
  return normalized
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function parseIndexSegment(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const parsed = Number.parseInt(segment, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasPath(target: unknown, path: string): boolean {
  const segments = toPathSegments(path);
  if (segments.length <= 0) return false;

  let current: unknown = target;
  for (const segment of segments) {
    const index = parseIndexSegment(segment);
    if (index !== null) {
      if (!Array.isArray(current) || index >= current.length) return false;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = toPathSegments(path);
  if (segments.length <= 0) return;

  let current: unknown = target;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    const segmentIndex = parseIndexSegment(segment);
    const isLast = index === segments.length - 1;

    if (segmentIndex !== null) {
      if (!Array.isArray(current)) return;
      while (current.length <= segmentIndex) current.push(undefined);
      if (isLast) {
        current[segmentIndex] = cloneJsonValue(value);
        return;
      }
      if (!isRecord(current[segmentIndex]) && !Array.isArray(current[segmentIndex])) {
        current[segmentIndex] = parseIndexSegment(nextSegment) !== null ? [] : {};
      }
      current = current[segmentIndex];
      continue;
    }

    if (!isRecord(current)) return;
    if (isLast) {
      current[segment] = cloneJsonValue(value);
      return;
    }
    if (!isRecord(current[segment]) && !Array.isArray(current[segment])) {
      current[segment] = parseIndexSegment(nextSegment) !== null ? [] : {};
    }
    current = current[segment];
  }
}

function deletePath(target: Record<string, unknown>, path: string): void {
  const segments = toPathSegments(path);
  if (segments.length <= 0) return;

  let current: unknown = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const segmentIndex = parseIndexSegment(segment);
    if (segmentIndex !== null) {
      if (!Array.isArray(current) || segmentIndex >= current.length) return;
      current = current[segmentIndex];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return;
    current = current[segment];
  }

  const lastSegment = segments[segments.length - 1];
  const lastIndex = parseIndexSegment(lastSegment);
  if (lastIndex !== null) {
    if (!Array.isArray(current) || lastIndex >= current.length) return;
    current.splice(lastIndex, 1);
    return;
  }
  if (!isRecord(current)) return;
  delete current[lastSegment];
}

function normalizePayloadRuleModels(value: unknown): PayloadRuleModel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const name = asTrimmedString(item.name);
      if (!name) return null;
      const protocol = asTrimmedString(item.protocol);
      return {
        name,
        ...(protocol ? { protocol } : {}),
      };
    })
    .filter((item): item is PayloadRuleModel => !!item);
}

function normalizePayloadValueRules(value: unknown): PayloadValueRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const models = normalizePayloadRuleModels(item.models);
      const params = isRecord(item.params) ? cloneJsonValue(item.params) : null;
      if (models.length <= 0 || !params) return null;
      return { models, params };
    })
    .filter((item): item is PayloadValueRule => !!item);
}

function normalizePayloadFilterRules(value: unknown): PayloadFilterRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const models = normalizePayloadRuleModels(item.models);
      const params = Array.isArray(item.params)
        ? item.params
          .map((entry) => asTrimmedString(entry))
          .filter((entry) => entry.length > 0)
        : [];
      if (models.length <= 0 || params.length <= 0) return null;
      return { models, params };
    })
    .filter((item): item is PayloadFilterRule => !!item);
}

function modelRuleMatches(rule: PayloadRuleModel, protocol: string, candidates: string[]): boolean {
  if (!rule.name || candidates.length <= 0) return false;
  const ruleProtocol = asTrimmedString(rule.protocol).toLowerCase();
  if (ruleProtocol && protocol && ruleProtocol !== protocol) return false;
  return candidates.some((candidate) => minimatch(candidate, rule.name, { nocase: true }));
}

function rulesMatch(models: PayloadRuleModel[], protocol: string, candidates: string[]): boolean {
  if (models.length <= 0 || candidates.length <= 0) return false;
  return models.some((rule) => modelRuleMatches(rule, protocol, candidates));
}

function parseRawRuleValue(value: unknown): unknown {
  if (typeof value !== 'string') return cloneJsonValue(value);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function createEmptyPayloadRulesConfig(): PayloadRulesConfig {
  return {
    default: [],
    defaultRaw: [],
    override: [],
    overrideRaw: [],
    filter: [],
  };
}

export function normalizePayloadRulesConfig(value: unknown): PayloadRulesConfig {
  if (!isRecord(value)) return createEmptyPayloadRulesConfig();
  return {
    default: normalizePayloadValueRules(value.default),
    defaultRaw: normalizePayloadValueRules(value.defaultRaw ?? value['default-raw']),
    override: normalizePayloadValueRules(value.override),
    overrideRaw: normalizePayloadValueRules(value.overrideRaw ?? value['override-raw']),
    filter: normalizePayloadFilterRules(value.filter),
  };
}

export function applyPayloadRules(input: {
  rules: PayloadRulesConfig;
  payload: Record<string, unknown>;
  modelName?: string;
  requestedModel?: string;
  protocol?: string;
}): Record<string, unknown> {
  const candidates = Array.from(new Set(
    [input.modelName, input.requestedModel]
      .map((value) => asTrimmedString(value))
      .filter((value) => value.length > 0),
  ));
  if (candidates.length <= 0) return input.payload;

  const rules = input.rules;
  const hasAnyRules = rules.default.length > 0
    || rules.defaultRaw.length > 0
    || rules.override.length > 0
    || rules.overrideRaw.length > 0
    || rules.filter.length > 0;
  if (!hasAnyRules) return input.payload;

  const protocol = asTrimmedString(input.protocol).toLowerCase();
  const original = cloneJsonValue(input.payload);
  const output = cloneJsonValue(input.payload);
  const appliedDefaults = new Set<string>();

  for (const rule of rules.default) {
    if (!rulesMatch(rule.models, protocol, candidates)) continue;
    for (const [path, value] of Object.entries(rule.params)) {
      const normalizedPath = asTrimmedString(path);
      if (!normalizedPath || hasPath(original, normalizedPath) || appliedDefaults.has(normalizedPath)) continue;
      setPath(output, normalizedPath, value);
      appliedDefaults.add(normalizedPath);
    }
  }

  for (const rule of rules.defaultRaw) {
    if (!rulesMatch(rule.models, protocol, candidates)) continue;
    for (const [path, value] of Object.entries(rule.params)) {
      const normalizedPath = asTrimmedString(path);
      if (!normalizedPath || hasPath(original, normalizedPath) || appliedDefaults.has(normalizedPath)) continue;
      const parsed = parseRawRuleValue(value);
      if (parsed === undefined) continue;
      setPath(output, normalizedPath, parsed);
      appliedDefaults.add(normalizedPath);
    }
  }

  for (const rule of rules.override) {
    if (!rulesMatch(rule.models, protocol, candidates)) continue;
    for (const [path, value] of Object.entries(rule.params)) {
      const normalizedPath = asTrimmedString(path);
      if (!normalizedPath) continue;
      setPath(output, normalizedPath, value);
    }
  }

  for (const rule of rules.overrideRaw) {
    if (!rulesMatch(rule.models, protocol, candidates)) continue;
    for (const [path, value] of Object.entries(rule.params)) {
      const normalizedPath = asTrimmedString(path);
      if (!normalizedPath) continue;
      const parsed = parseRawRuleValue(value);
      if (parsed === undefined) continue;
      setPath(output, normalizedPath, parsed);
    }
  }

  for (const rule of rules.filter) {
    if (!rulesMatch(rule.models, protocol, candidates)) continue;
    for (const path of rule.params) {
      const normalizedPath = asTrimmedString(path);
      if (!normalizedPath) continue;
      deletePath(output, normalizedPath);
    }
  }

  return output;
}
