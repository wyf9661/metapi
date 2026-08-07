/**
 * Config constants, types and pure helpers for the settings page. Extracted
 * from Settings.tsx (which was ~2.4k lines) — pure move, zero behavior change.
 */
import type { RoutingWeights } from '../helpers/routingProfiles.js';
import type {
  PayloadRuleAction,
  VisualPayloadRuleValueMode,
} from './payloadRulesVisual.js';

export const SECONDS_PER_DAY = 24 * 60 * 60;

export const ROUTE_COOLDOWN_UNIT_OPTIONS = [
  { value: 'second', label: '秒', multiplierSec: 1 },
  { value: 'minute', label: '分钟', multiplierSec: 60 },
  { value: 'hour', label: '小时', multiplierSec: 60 * 60 },
  { value: 'day', label: '天', multiplierSec: SECONDS_PER_DAY },
] as const;

export const CHECKIN_SCHEDULE_MODE_OPTIONS = [
  { value: 'cron', label: 'Cron' },
  { value: 'interval', label: '间隔签到' },
] as const;

export const CHECKIN_INTERVAL_OPTIONS = Array.from({ length: 24 }, (_, index) => {
  const hour = index + 1;
  return {
    value: String(hour),
    label: `${hour} 小时`,
  };
});

export type DbDialect = 'sqlite' | 'mysql' | 'postgres';
export type RouteCooldownUnit = typeof ROUTE_COOLDOWN_UNIT_OPTIONS[number]['value'];
export type PayloadRulesEditorSectionKey = PayloadRuleAction;
export type PayloadRulesEditorDrafts = Record<PayloadRulesEditorSectionKey, string>;

export type ShorthandConnection = {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
};

export const PAYLOAD_RULES_EDITOR_SECTIONS = [
  {
    key: 'default',
    title: 'default',
    description: '字段缺失时才注入，适合补默认参数。',
    placeholder: `[
  {
    "models": [{ "name": "gpt-*", "protocol": "codex" }],
    "params": {
      "reasoning.effort": "high"
    }
  }
]`,
  },
  {
    key: 'default-raw',
    title: 'default-raw',
    description: '字段缺失时注入原始 JSON，适合 schema、复杂对象等值。',
    placeholder: `[
  {
    "models": [{ "name": "gpt-*", "protocol": "codex" }],
    "params": {
      "response_format": "{\\"type\\":\\"json_schema\\"}"
    }
  }
]`,
  },
  {
    key: 'override',
    title: 'override',
    description: '无论原请求是否已有该字段，都强制覆盖。',
    placeholder: `[
  {
    "models": [{ "name": "gpt-*", "protocol": "codex" }],
    "params": {
      "text.verbosity": "low"
    }
  }
]`,
  },
  {
    key: 'override-raw',
    title: 'override-raw',
    description: '无论原请求是否已有该字段，都强制覆盖为原始 JSON。',
    placeholder: `[
  {
    "models": [{ "name": "gemini-*", "protocol": "gemini" }],
    "params": {
      "generationConfig.responseJsonSchema": "{\\"type\\":\\"object\\"}"
    }
  }
]`,
  },
  {
    key: 'filter',
    title: 'filter',
    description: '删除匹配请求中的字段。',
    placeholder: `[
  {
    "models": [{ "name": "gpt-*", "protocol": "codex" }],
    "params": ["safety_identifier"]
  }
]`,
  },
] as const satisfies ReadonlyArray<{
  key: PayloadRulesEditorSectionKey;
  title: string;
  description: string;
  placeholder: string;
}>;

export const PAYLOAD_RULE_ACTION_OPTIONS: Array<{ value: PayloadRuleAction; label: string }> = [
  { value: 'default', label: '默认注入' },
  { value: 'default-raw', label: '默认注入 JSON' },
  { value: 'override', label: '强制覆盖' },
  { value: 'override-raw', label: '强制覆盖 JSON' },
  { value: 'filter', label: '删除字段' },
];

export const PAYLOAD_RULE_VALUE_MODE_OPTIONS: Array<{ value: VisualPayloadRuleValueMode; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'json', label: 'JSON' },
];

export function createEmptyPayloadRuleDrafts(): PayloadRulesEditorDrafts {
  return {
    default: '',
    'default-raw': '',
    override: '',
    'override-raw': '',
    filter: '',
  };
}

export function formatPayloadRuleSectionForEditor(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value) && value.length <= 0) return '';
  return JSON.stringify(value, null, 2);
}

export function normalizePayloadRulesForEditor(value: unknown): PayloadRulesEditorDrafts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createEmptyPayloadRuleDrafts();
  }

  const record = value as Record<string, unknown>;
  return {
    default: formatPayloadRuleSectionForEditor(record.default),
    'default-raw': formatPayloadRuleSectionForEditor(record.defaultRaw ?? record['default-raw']),
    override: formatPayloadRuleSectionForEditor(record.override),
    'override-raw': formatPayloadRuleSectionForEditor(record.overrideRaw ?? record['override-raw']),
    filter: formatPayloadRuleSectionForEditor(record.filter),
  };
}

export function parsePayloadRulesFromDrafts(
  drafts: PayloadRulesEditorDrafts,
): { success: true; value: Record<string, unknown> } | { success: false; message: string } {
  const next: Record<string, unknown> = {};

  for (const section of PAYLOAD_RULES_EDITOR_SECTIONS) {
    const raw = drafts[section.key].trim();
    if (!raw) continue;
    try {
      next[section.key] = JSON.parse(raw);
    } catch (error: any) {
      return {
        success: false,
        message: `Payload 规则 ${section.title} 不是合法 JSON：${error?.message || '解析失败'}`,
      };
    }
  }

  return {
    success: true,
    value: next,
  };
}

export const defaultWeights: RoutingWeights = {
  baseWeightFactor: 0.5,
  valueScoreFactor: 0.5,
  costWeight: 0.4,
  balanceWeight: 0.3,
  usageWeight: 0.3,
};

export function getDialectDefaults(dialect: DbDialect) {
  if (dialect === 'mysql') {
    return { port: '3306', database: 'mysql' };
  }
  if (dialect === 'postgres') {
    return { port: '5432', database: 'postgres' };
  }
  return { port: '', database: '' };
}

export function buildShorthandConnectionString(dialect: DbDialect, input: ShorthandConnection): string {
  if (dialect === 'sqlite') return '';
  const host = input.host.trim();
  const user = input.user.trim();
  const password = input.password;
  if (!host || !user || !password) return '';
  const defaults = getDialectDefaults(dialect);
  const port = (input.port || defaults.port).trim() || defaults.port;
  const database = (input.database || defaults.database).trim() || defaults.database;
  const protocol = dialect === 'mysql' ? 'mysql' : 'postgres';
  return `${protocol}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

export function inferUrlDialect(connectionString: string): 'mysql' | 'postgres' | null {
  const normalized = (connectionString || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith('mysql://')) return 'mysql';
  if (normalized.startsWith('postgres://') || normalized.startsWith('postgresql://')) return 'postgres';
  return null;
}

export function resolveRouteCooldownInput(seconds: number | null | undefined): {
  value: number;
  unit: RouteCooldownUnit;
} {
  const normalizedSeconds = Number.isFinite(Number(seconds)) && Number(seconds) > 0
    ? Math.max(1, Math.trunc(Number(seconds)))
    : 30 * SECONDS_PER_DAY;

  for (const option of [...ROUTE_COOLDOWN_UNIT_OPTIONS].reverse()) {
    if (normalizedSeconds % option.multiplierSec === 0) {
      return {
        value: normalizedSeconds / option.multiplierSec,
        unit: option.value,
      };
    }
  }

  return {
    value: normalizedSeconds,
    unit: 'second',
  };
}

export function toRouteCooldownSeconds(value: number, unit: RouteCooldownUnit): number {
  const normalizedValue = Number.isFinite(value) && value > 0 ? Math.max(1, Math.trunc(value)) : 1;
  const unitConfig = ROUTE_COOLDOWN_UNIT_OPTIONS.find((option) => option.value === unit) || ROUTE_COOLDOWN_UNIT_OPTIONS[0];
  return normalizedValue * unitConfig.multiplierSec;
}
