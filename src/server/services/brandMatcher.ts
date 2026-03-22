/**
 * Server-side brand matching for global brand filtering.
 *
 * Context-building logic is ported from the frontend BrandIcon.tsx
 * (collectBrandCandidates + buildMatchContext) to ensure identical
 * matching behavior between route display and rebuild filtering.
 */

type MatchMode = 'includes' | 'startsWith' | 'segment' | 'boundary';
type KeywordRule = { keyword: string; mode: MatchMode };

const BRAND_RULES: Record<string, KeywordRule[]> = {
  'OpenAI': [
    { keyword: 'gpt', mode: 'startsWith' },
    { keyword: 'chatgpt', mode: 'startsWith' },
    { keyword: 'dall-e', mode: 'startsWith' },
    { keyword: 'whisper', mode: 'startsWith' },
    { keyword: 'text-embedding', mode: 'startsWith' },
    { keyword: 'text-moderation', mode: 'startsWith' },
    { keyword: 'davinci', mode: 'startsWith' },
    { keyword: 'babbage', mode: 'startsWith' },
    { keyword: 'codex-mini', mode: 'startsWith' },
    { keyword: 'o1', mode: 'startsWith' },
    { keyword: 'o3', mode: 'startsWith' },
    { keyword: 'o4', mode: 'startsWith' },
    { keyword: 'tts', mode: 'startsWith' },
  ],
  'Anthropic': [
    { keyword: 'claude', mode: 'includes' },
  ],
  'Google': [
    { keyword: 'gemini', mode: 'includes' },
    { keyword: 'gemma', mode: 'includes' },
    { keyword: 'google/', mode: 'includes' },
    { keyword: 'palm', mode: 'includes' },
    { keyword: 'paligemma', mode: 'includes' },
    { keyword: 'shieldgemma', mode: 'includes' },
    { keyword: 'recurrentgemma', mode: 'includes' },
    { keyword: 'deplot', mode: 'includes' },
    { keyword: 'codegemma', mode: 'includes' },
    { keyword: 'imagen', mode: 'includes' },
    { keyword: 'learnlm', mode: 'includes' },
    { keyword: 'aqa', mode: 'includes' },
    { keyword: 'veo', mode: 'startsWith' },
  ],
  'DeepSeek': [
    { keyword: 'deepseek', mode: 'includes' },
    { keyword: 'ds-chat', mode: 'segment' },
  ],
  '通义千问': [
    { keyword: 'qwen', mode: 'includes' },
    { keyword: 'qwq', mode: 'includes' },
    { keyword: 'tongyi', mode: 'includes' },
  ],
  '智谱 AI': [
    { keyword: 'glm', mode: 'includes' },
    { keyword: 'chatglm', mode: 'includes' },
    { keyword: 'codegeex', mode: 'includes' },
    { keyword: 'cogview', mode: 'includes' },
    { keyword: 'cogvideo', mode: 'includes' },
  ],
  'Meta': [
    { keyword: 'llama', mode: 'includes' },
    { keyword: 'code-llama', mode: 'includes' },
    { keyword: 'codellama', mode: 'includes' },
  ],
  'Mistral': [
    { keyword: 'mistral', mode: 'includes' },
    { keyword: 'mixtral', mode: 'includes' },
    { keyword: 'codestral', mode: 'includes' },
    { keyword: 'pixtral', mode: 'includes' },
    { keyword: 'ministral', mode: 'includes' },
    { keyword: 'voxtral', mode: 'includes' },
    { keyword: 'magistral', mode: 'includes' },
  ],
  'Moonshot': [
    { keyword: 'moonshot', mode: 'includes' },
    { keyword: 'kimi', mode: 'includes' },
  ],
  '零一万物': [
    { keyword: 'yi-', mode: 'startsWith' },
    { keyword: 'yi', mode: 'boundary' },
  ],
  '文心一言': [
    { keyword: 'ernie', mode: 'includes' },
    { keyword: 'eb-', mode: 'includes' },
  ],
  '讯飞星火': [
    { keyword: 'spark', mode: 'includes' },
    { keyword: 'generalv', mode: 'includes' },
  ],
  '腾讯混元': [
    { keyword: 'hunyuan', mode: 'includes' },
    { keyword: 'tencent-hunyuan', mode: 'includes' },
  ],
  '豆包': [
    { keyword: 'doubao', mode: 'includes' },
  ],
  'MiniMax': [
    { keyword: 'minimax', mode: 'includes' },
    { keyword: 'abab', mode: 'includes' },
    { keyword: 'mini2.1', mode: 'segment' },
  ],
  'Cohere': [
    { keyword: 'command', mode: 'includes' },
    { keyword: 'c4ai-', mode: 'includes' },
    { keyword: 'embed-', mode: 'startsWith' },
  ],
  'Microsoft': [
    { keyword: 'microsoft/', mode: 'includes' },
    { keyword: 'phi-', mode: 'includes' },
    { keyword: 'kosmos', mode: 'includes' },
    { keyword: 'phi4', mode: 'segment' },
  ],
  'xAI': [
    { keyword: 'grok', mode: 'includes' },
  ],
  '阶跃星辰': [
    { keyword: 'stepfun', mode: 'includes' },
    { keyword: 'step-', mode: 'startsWith' },
    { keyword: 'step3', mode: 'startsWith' },
  ],
  'Stability': [
    { keyword: 'flux', mode: 'includes' },
    { keyword: 'stablediffusion', mode: 'includes' },
    { keyword: 'stable-diffusion', mode: 'includes' },
    { keyword: 'sdxl', mode: 'includes' },
    { keyword: 'sd3', mode: 'startsWith' },
  ],
  'NVIDIA': [
    { keyword: 'nvidia/', mode: 'includes' },
    { keyword: 'nvclip', mode: 'includes' },
    { keyword: 'nemotron', mode: 'includes' },
    { keyword: 'nemoretriever', mode: 'includes' },
    { keyword: 'neva', mode: 'includes' },
    { keyword: 'riva-translate', mode: 'includes' },
    { keyword: 'cosmos', mode: 'includes' },
    { keyword: 'nv-', mode: 'startsWith' },
  ],
  'IBM': [
    { keyword: 'ibm/', mode: 'includes' },
    { keyword: 'granite', mode: 'includes' },
  ],
  'BAAI': [
    { keyword: 'baai/', mode: 'includes' },
    { keyword: 'bge-', mode: 'includes' },
  ],
  'ByteDance': [
    { keyword: 'bytedance', mode: 'includes' },
    { keyword: 'seed-oss', mode: 'includes' },
    { keyword: 'kolors', mode: 'includes' },
    { keyword: 'kwai', mode: 'includes' },
    { keyword: 'kwaipilot', mode: 'includes' },
    { keyword: 'wan-', mode: 'startsWith' },
    { keyword: 'kat-', mode: 'startsWith' },
  ],
  'InternLM': [
    { keyword: 'internlm', mode: 'includes' },
  ],
  'Midjourney': [
    { keyword: 'midjourney', mode: 'includes' },
    { keyword: 'mj_', mode: 'startsWith' },
  ],
  'DeepL': [
    { keyword: 'deepl/', mode: 'includes' },
    { keyword: 'deepl-', mode: 'startsWith' },
  ],
  'Jina AI': [
    { keyword: 'jina', mode: 'includes' },
  ],
};

// ── Context building (ported from frontend BrandIcon.tsx) ──

function stripCommonWrappers(value: string): string {
  return value
    .replace(/^(?:\[[^\]]+\]|【[^】]+】)\s*/g, '')
    .replace(/^re:\s*/g, '')
    .replace(/^\^+/, '')
    .replace(/\$+$/, '')
    .trim();
}

/**
 * Recursively split model name on `/`, `:`, `,` to build all candidate strings.
 * Mirrors the frontend collectBrandCandidates exactly.
 */
function collectCandidates(modelName: string): string[] {
  const queue: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    queue.push(normalized);
  };

  push(modelName);

  for (let i = 0; i < queue.length; i++) {
    const candidate = queue[i]!;
    const cleaned = stripCommonWrappers(candidate);
    push(cleaned);
    if (cleaned.includes('/')) for (const part of cleaned.split('/')) push(part);
    if (cleaned.includes(':')) for (const part of cleaned.split(':')) push(part);
    if (cleaned.includes(',')) for (const part of cleaned.split(',')) push(part);
  }

  return queue;
}

type MatchContext = {
  raw: string;       // first candidate (normalized full name)
  candidates: string[];  // all candidates from recursive splitting
  segments: string[];    // candidates split on /,:,\s (NOT on - or _)
};

function buildMatchContext(modelName: string): MatchContext {
  const candidates = collectCandidates(modelName);
  const raw = candidates[0] || modelName.trim().toLowerCase();
  // Segments split on /,:,whitespace only — NOT on - or _ (matches frontend)
  const segments = Array.from(new Set(
    candidates
      .flatMap((c) => c.split(/[/:,\s]+/g))
      .map((s) => s.trim())
      .filter(Boolean),
  ));
  return { raw, candidates, segments };
}

// ── Matching functions (mirror frontend includesAny / startsWithAny / hasExactSegment / matchesBoundary) ──

function matchesRule(ctx: MatchContext, rule: KeywordRule): boolean {
  switch (rule.mode) {
    case 'includes':
      return ctx.raw.includes(rule.keyword)
        || ctx.candidates.some((c) => c.includes(rule.keyword));
    case 'startsWith':
      return ctx.raw.startsWith(rule.keyword)
        || ctx.segments.some((s) => s.startsWith(rule.keyword))
        || ctx.candidates.some((c) => c.startsWith(rule.keyword));
    case 'segment':
      return ctx.segments.includes(rule.keyword);
    case 'boundary': {
      const pattern = new RegExp(`(^|[/:_\\-\\s])${rule.keyword}(?=$|[/:_\\-\\s])`);
      return pattern.test(ctx.raw) || ctx.candidates.some((c) => pattern.test(c));
    }
    default:
      return false;
  }
}

// ── Public API ──

export function getAllBrandNames(): string[] {
  return Object.keys(BRAND_RULES);
}

export function getBlockedBrandRules(blockedBrands: string[]): KeywordRule[] {
  const rules: KeywordRule[] = [];
  for (const brand of blockedBrands) {
    const brandRules = BRAND_RULES[brand];
    if (brandRules) rules.push(...brandRules);
  }
  return rules;
}

export function isModelBlockedByBrand(modelName: string, rules: KeywordRule[]): boolean {
  if (!modelName || rules.length === 0) return false;
  const ctx = buildMatchContext(modelName);
  if (!ctx.raw) return false;
  return rules.some((rule) => matchesRule(ctx, rule));
}
