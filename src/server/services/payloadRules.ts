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

type PayloadRulesParseSuccess = {
  success: true;
  normalized: PayloadRulesConfig;
};

type PayloadRulesParseFailure = {
  success: false;
  message: string;
};

export type PayloadRulesParseResult = PayloadRulesParseSuccess | PayloadRulesParseFailure;

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

const PAYLOAD_RULE_SECTION_LABELS = {
  default: 'default',
  defaultRaw: 'default-raw',
  override: 'override',
  overrideRaw: 'override-raw',
  filter: 'filter',
} as const;

const PAYLOAD_RULE_ALLOWED_KEYS = new Set([
  'default',
  'defaultRaw',
  'default-raw',
  'override',
  'overrideRaw',
  'override-raw',
  'filter',
]);

function getPayloadRulesSectionValue(value: Record<string, unknown>, key: keyof typeof PAYLOAD_RULE_SECTION_LABELS): unknown {
  if (key === 'defaultRaw') return value.defaultRaw ?? value['default-raw'];
  if (key === 'overrideRaw') return value.overrideRaw ?? value['override-raw'];
  return value[key];
}

function hasConflictingPayloadRuleSectionKeys(value: Record<string, unknown>, camelKey: 'defaultRaw' | 'overrideRaw', dashedKey: 'default-raw' | 'override-raw'): boolean {
  return Object.prototype.hasOwnProperty.call(value, camelKey) && Object.prototype.hasOwnProperty.call(value, dashedKey);
}

function validatePayloadRuleModelsInput(value: unknown, section: string, ruleIndex: number): string | null {
  if (!Array.isArray(value) || value.length <= 0) {
    return `Payload 规则 ${section} 第 ${ruleIndex} 条的 models 必须是非空数组`;
  }

  for (let modelIndex = 0; modelIndex < value.length; modelIndex += 1) {
    const model = value[modelIndex];
    if (!isRecord(model)) {
      return `Payload 规则 ${section} 第 ${ruleIndex} 条的 models[${modelIndex + 1}] 必须是对象`;
    }
    if (!asTrimmedString(model.name)) {
      return `Payload 规则 ${section} 第 ${ruleIndex} 条的 models[${modelIndex + 1}].name 不能为空`;
    }
    if (model.protocol !== undefined && typeof model.protocol !== 'string') {
      return `Payload 规则 ${section} 第 ${ruleIndex} 条的 models[${modelIndex + 1}].protocol 必须是字符串`;
    }
  }

  return null;
}

function validatePayloadValueRuleSectionInput(value: unknown, section: string, raw: boolean): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    return `Payload 规则 ${section} 必须是数组`;
  }

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) {
      return `Payload 规则 ${section} 第 ${index + 1} 条必须是对象`;
    }

    const modelsError = validatePayloadRuleModelsInput(item.models, section, index + 1);
    if (modelsError) return modelsError;

    if (!isRecord(item.params) || Object.keys(item.params).length <= 0) {
      return `Payload 规则 ${section} 第 ${index + 1} 条的 params 必须是非空对象`;
    }

    for (const [path, rawValue] of Object.entries(item.params)) {
      if (!asTrimmedString(path)) {
        return `Payload 规则 ${section} 第 ${index + 1} 条包含空参数路径`;
      }
      if (!raw) continue;
      if (typeof rawValue !== 'string') continue;
      const trimmed = rawValue.trim();
      if (!trimmed) {
        return `Payload 规则 ${section} 第 ${index + 1} 条的 ${path} 不能为空字符串`;
      }
      try {
        JSON.parse(trimmed);
      } catch {
        return `Payload 规则 ${section} 第 ${index + 1} 条的 ${path} 不是合法 JSON`;
      }
    }
  }

  return null;
}

function validatePayloadFilterRuleSectionInput(value: unknown, section: string): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    return `Payload 规则 ${section} 必须是数组`;
  }

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) {
      return `Payload 规则 ${section} 第 ${index + 1} 条必须是对象`;
    }

    const modelsError = validatePayloadRuleModelsInput(item.models, section, index + 1);
    if (modelsError) return modelsError;

    if (!Array.isArray(item.params) || item.params.length <= 0) {
      return `Payload 规则 ${section} 第 ${index + 1} 条的 params 必须是非空字符串数组`;
    }

    for (let pathIndex = 0; pathIndex < item.params.length; pathIndex += 1) {
      if (!asTrimmedString(item.params[pathIndex])) {
        return `Payload 规则 ${section} 第 ${index + 1} 条的 params[${pathIndex + 1}] 不能为空`;
      }
    }
  }

  return null;
}

export function parsePayloadRulesConfigInput(value: unknown): PayloadRulesParseResult {
  if (value == null) {
    return { success: true, normalized: createEmptyPayloadRulesConfig() };
  }
  if (!isRecord(value)) {
    return { success: false, message: 'Payload 规则必须是 JSON 对象' };
  }

  if (hasConflictingPayloadRuleSectionKeys(value, 'defaultRaw', 'default-raw')) {
    return { success: false, message: 'Payload 规则不能同时包含 defaultRaw 和 default-raw' };
  }
  if (hasConflictingPayloadRuleSectionKeys(value, 'overrideRaw', 'override-raw')) {
    return { success: false, message: 'Payload 规则不能同时包含 overrideRaw 和 override-raw' };
  }

  const unknownKeys = Object.keys(value).filter((key) => !PAYLOAD_RULE_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return {
      success: false,
      message: `Payload 规则包含未知分组：${unknownKeys.join(', ')}`,
    };
  }

  const valueSectionError = validatePayloadValueRuleSectionInput(value.default, PAYLOAD_RULE_SECTION_LABELS.default, false)
    ?? validatePayloadValueRuleSectionInput(getPayloadRulesSectionValue(value, 'defaultRaw'), PAYLOAD_RULE_SECTION_LABELS.defaultRaw, true)
    ?? validatePayloadValueRuleSectionInput(value.override, PAYLOAD_RULE_SECTION_LABELS.override, false)
    ?? validatePayloadValueRuleSectionInput(getPayloadRulesSectionValue(value, 'overrideRaw'), PAYLOAD_RULE_SECTION_LABELS.overrideRaw, true)
    ?? validatePayloadFilterRuleSectionInput(value.filter, PAYLOAD_RULE_SECTION_LABELS.filter);
  if (valueSectionError) {
    return {
      success: false,
      message: valueSectionError,
    };
  }

  return {
    success: true,
    normalized: normalizePayloadRulesConfig(value),
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
