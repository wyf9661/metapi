export type PayloadRuleAction = 'default' | 'default-raw' | 'override' | 'override-raw' | 'filter';
export type VisualPayloadRuleValueMode = 'text' | 'json';

export type VisualPayloadRule = {
  id: string;
  action: PayloadRuleAction;
  modelPattern: string;
  protocol: string;
  path: string;
  value: string;
  valueMode: VisualPayloadRuleValueMode;
};

let payloadRuleIdCounter = 0;

function nextPayloadRuleId(): string {
  payloadRuleIdCounter += 1;
  return `payload-rule-${payloadRuleIdCounter}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formatJsonValue(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatRawValue(value: unknown): string {
  return typeof value === 'string' ? value : formatJsonValue(value);
}

export function createVisualPayloadRule(input: Partial<VisualPayloadRule> = {}): VisualPayloadRule {
  return {
    id: input.id || nextPayloadRuleId(),
    action: input.action || 'default',
    modelPattern: input.modelPattern || '',
    protocol: input.protocol || '',
    path: input.path || '',
    value: input.value || '',
    valueMode: input.valueMode || 'text',
  };
}

export function isVisualPayloadRuleBlank(rule: VisualPayloadRule): boolean {
  return !rule.modelPattern.trim()
    && !rule.protocol.trim()
    && !rule.path.trim()
    && !rule.value.trim();
}

export function createCodexDefaultHighReasoningVisualPreset(): VisualPayloadRule[] {
  return [
    createVisualPayloadRule({
      action: 'default',
      modelPattern: 'gpt-*',
      protocol: 'codex',
      path: 'reasoning.effort',
      value: 'high',
      valueMode: 'text',
    }),
  ];
}

export function payloadRulesToVisualRules(value: unknown): VisualPayloadRule[] {
  if (!isRecord(value)) return [];

  const rules: VisualPayloadRule[] = [];
  const appendValueRules = (action: Exclude<PayloadRuleAction, 'filter'>, input: unknown) => {
    if (!Array.isArray(input)) return;
    for (const entry of input) {
      if (!isRecord(entry)) continue;
      const models = Array.isArray(entry.models) ? entry.models : [];
      const params = isRecord(entry.params) ? entry.params : null;
      if (!params) continue;
      for (const model of models) {
        if (!isRecord(model)) continue;
        const modelPattern = asTrimmedString(model.name);
        if (!modelPattern) continue;
        const protocol = asTrimmedString(model.protocol);
        for (const [path, rawValue] of Object.entries(params)) {
          const normalizedPath = asTrimmedString(path);
          if (!normalizedPath) continue;
          if (action === 'default-raw' || action === 'override-raw') {
            rules.push(createVisualPayloadRule({
              action,
              modelPattern,
              protocol,
              path: normalizedPath,
              value: formatRawValue(rawValue),
              valueMode: 'json',
            }));
            continue;
          }
          rules.push(createVisualPayloadRule({
            action,
            modelPattern,
            protocol,
            path: normalizedPath,
            value: typeof rawValue === 'string' ? rawValue : formatJsonValue(rawValue),
            valueMode: typeof rawValue === 'string' ? 'text' : 'json',
          }));
        }
      }
    }
  };

  const appendFilterRules = (input: unknown) => {
    if (!Array.isArray(input)) return;
    for (const entry of input) {
      if (!isRecord(entry)) continue;
      const models = Array.isArray(entry.models) ? entry.models : [];
      const params = Array.isArray(entry.params) ? entry.params : [];
      for (const model of models) {
        if (!isRecord(model)) continue;
        const modelPattern = asTrimmedString(model.name);
        if (!modelPattern) continue;
        const protocol = asTrimmedString(model.protocol);
        for (const path of params) {
          const normalizedPath = asTrimmedString(path);
          if (!normalizedPath) continue;
          rules.push(createVisualPayloadRule({
            action: 'filter',
            modelPattern,
            protocol,
            path: normalizedPath,
            value: '',
            valueMode: 'text',
          }));
        }
      }
    }
  };

  appendValueRules('default', value.default);
  appendValueRules('default-raw', value.defaultRaw ?? value['default-raw']);
  appendValueRules('override', value.override);
  appendValueRules('override-raw', value.overrideRaw ?? value['override-raw']);
  appendFilterRules(value.filter);

  return rules;
}

type PayloadRulesSerializeSuccess = {
  success: true;
  value: Record<string, unknown>;
};

type PayloadRulesSerializeFailure = {
  success: false;
  message: string;
};

export type VisualPayloadRulesSerializeResult = PayloadRulesSerializeSuccess | PayloadRulesSerializeFailure;

type AggregatedValueRule = {
  models: Array<{ name: string; protocol?: string }>;
  params: Record<string, unknown>;
};

type AggregatedFilterRule = {
  models: Array<{ name: string; protocol?: string }>;
  params: string[];
};

function buildModelRule(rule: VisualPayloadRule): { name: string; protocol?: string } {
  const protocol = rule.protocol.trim();
  return protocol ? { name: rule.modelPattern.trim(), protocol } : { name: rule.modelPattern.trim() };
}

function normalizeValueForRule(rule: VisualPayloadRule): { success: true; value: unknown } | PayloadRulesSerializeFailure {
  if (rule.action === 'filter') {
    return { success: true, value: undefined };
  }

  if (rule.action === 'default-raw' || rule.action === 'override-raw') {
    const trimmed = rule.value.trim();
    if (!trimmed) {
      return { success: false, message: '原始 JSON 值不能为空' };
    }
    try {
      JSON.parse(trimmed);
    } catch (error: any) {
      return { success: false, message: `原始 JSON 无效：${error?.message || '解析失败'}` };
    }
    return { success: true, value: trimmed };
  }

  if (rule.valueMode === 'json') {
    const trimmed = rule.value.trim();
    if (!trimmed) {
      return { success: false, message: 'JSON 值不能为空' };
    }
    try {
      return { success: true, value: JSON.parse(trimmed) };
    } catch (error: any) {
      return { success: false, message: `JSON 值无效：${error?.message || '解析失败'}` };
    }
  }

  if (!rule.value) {
    return { success: false, message: '文本值不能为空' };
  }
  return { success: true, value: rule.value };
}

export function visualRulesToPayloadRules(rules: VisualPayloadRule[]): VisualPayloadRulesSerializeResult {
  const sections = {
    default: new Map<string, AggregatedValueRule>(),
    'default-raw': new Map<string, AggregatedValueRule>(),
    override: new Map<string, AggregatedValueRule>(),
    'override-raw': new Map<string, AggregatedValueRule>(),
    filter: new Map<string, AggregatedFilterRule>(),
  };

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (isVisualPayloadRuleBlank(rule)) continue;

    const modelPattern = rule.modelPattern.trim();
    if (!modelPattern) {
      return { success: false, message: `第 ${index + 1} 条规则缺少模型匹配` };
    }
    const path = rule.path.trim();
    if (!path) {
      return { success: false, message: `第 ${index + 1} 条规则缺少字段路径` };
    }

    const normalizedValue = normalizeValueForRule(rule);
    if (!normalizedValue.success) {
      return {
        success: false,
        message: `第 ${index + 1} 条规则保存失败：${normalizedValue.message}`,
      };
    }

    const groupKey = `${modelPattern}\u0000${rule.protocol.trim()}`;
    if (rule.action === 'filter') {
      const existing = sections.filter.get(groupKey) || {
        models: [buildModelRule(rule)],
        params: [],
      };
      if (!existing.params.includes(path)) {
        existing.params.push(path);
      }
      sections.filter.set(groupKey, existing);
      continue;
    }

    const targetSection = sections[rule.action];
    const existing = targetSection.get(groupKey) || {
      models: [buildModelRule(rule)],
      params: {},
    };
    existing.params[path] = normalizedValue.value;
    targetSection.set(groupKey, existing);
  }

  return {
    success: true,
    value: {
      default: Array.from(sections.default.values()),
      'default-raw': Array.from(sections['default-raw'].values()),
      override: Array.from(sections.override.values()),
      'override-raw': Array.from(sections['override-raw'].values()),
      filter: Array.from(sections.filter.values()),
    },
  };
}
