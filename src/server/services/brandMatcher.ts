/**
 * Server-side brand matching for global brand filtering.
 *
 * Matching semantics are aligned with the frontend BrandIcon.tsx BRAND_DEFINITIONS:
 * - `includes`: substring match (e.g. 'claude' matches 'claude-3-opus')
 * - `startsWith`: segment-level startsWith (e.g. 'gpt' matches 'gpt-4o' but not 'some-gpt')
 * - `segment`: exact segment match after splitting on /:-_ delimiters
 * - `boundary`: word-boundary regex match
 */

type MatchMode = 'includes' | 'startsWith' | 'segment' | 'boundary';
type KeywordRule = { keyword: string; mode: MatchMode };

const BRAND_RULES: Record<string, KeywordRule[]> = {
  // OpenAI: all startsWithAny in frontend
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
  // Anthropic: includesAny
  'Anthropic': [
    { keyword: 'claude', mode: 'includes' },
  ],
  // Google: includesAny + startsWithAny for veo/google/
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
  // DeepSeek: includesAny + hasExactSegment
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
  // 零一万物: startsWithAny('yi-') + matchesBoundary
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
  // MiniMax: includesAny + hasExactSegment
  'MiniMax': [
    { keyword: 'minimax', mode: 'includes' },
    { keyword: 'abab', mode: 'includes' },
    { keyword: 'mini2.1', mode: 'segment' },
  ],
  // Cohere: includesAny + startsWithAny('embed-')
  'Cohere': [
    { keyword: 'command', mode: 'includes' },
    { keyword: 'c4ai-', mode: 'includes' },
    { keyword: 'embed-', mode: 'startsWith' },
  ],
  // Microsoft: includesAny + hasExactSegment('phi4')
  'Microsoft': [
    { keyword: 'microsoft/', mode: 'includes' },
    { keyword: 'phi-', mode: 'includes' },
    { keyword: 'kosmos', mode: 'includes' },
    { keyword: 'phi4', mode: 'segment' },
  ],
  'xAI': [
    { keyword: 'grok', mode: 'includes' },
  ],
  // 阶跃星辰: includesAny('stepfun') + startsWithAny('step-', 'step3')
  '阶跃星辰': [
    { keyword: 'stepfun', mode: 'includes' },
    { keyword: 'step-', mode: 'startsWith' },
    { keyword: 'step3', mode: 'startsWith' },
  ],
  // Stability: includesAny + startsWithAny('sd3')
  'Stability': [
    { keyword: 'flux', mode: 'includes' },
    { keyword: 'stablediffusion', mode: 'includes' },
    { keyword: 'stable-diffusion', mode: 'includes' },
    { keyword: 'sdxl', mode: 'includes' },
    { keyword: 'sd3', mode: 'startsWith' },
  ],
  // NVIDIA: includesAny + startsWithAny('nv-')
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
  // ByteDance: includesAny + startsWithAny('wan-', 'kat-')
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
  // Midjourney: includesAny + startsWithAny('mj_')
  'Midjourney': [
    { keyword: 'midjourney', mode: 'includes' },
    { keyword: 'mj_', mode: 'startsWith' },
  ],
  // DeepL: startsWithAny('deepl-') + includesAny('deepl/')
  'DeepL': [
    { keyword: 'deepl/', mode: 'includes' },
    { keyword: 'deepl-', mode: 'startsWith' },
  ],
  'Jina AI': [
    { keyword: 'jina', mode: 'includes' },
  ],
};

/**
 * Get all available brand names.
 */
export function getAllBrandNames(): string[] {
  return Object.keys(BRAND_RULES);
}

/**
 * Collect the rules for the blocked brands.
 */
export function getBlockedBrandRules(blockedBrands: string[]): KeywordRule[] {
  const rules: KeywordRule[] = [];
  for (const brand of blockedBrands) {
    const brandRules = BRAND_RULES[brand];
    if (brandRules) rules.push(...brandRules);
  }
  return rules;
}

/**
 * Split model name into segments (matching the frontend's segment logic).
 */
function getSegments(lower: string): string[] {
  return lower.split(/[/:,\s_\-]+/g).filter(Boolean);
}

/**
 * Check if a model name matches a single keyword rule.
 */
function matchesRule(lower: string, segments: string[], rule: KeywordRule): boolean {
  switch (rule.mode) {
    case 'includes':
      return lower.includes(rule.keyword);
    case 'startsWith':
      // Match if any segment starts with the keyword, or the full name starts with it
      return lower.startsWith(rule.keyword) || segments.some((seg) => seg.startsWith(rule.keyword));
    case 'segment':
      return segments.includes(rule.keyword);
    case 'boundary': {
      const pattern = new RegExp(`(^|[^a-z0-9])${rule.keyword}(?=$|[^a-z0-9])`);
      return pattern.test(lower);
    }
    default:
      return false;
  }
}

/**
 * Check if a model name matches any of the blocked brand rules.
 */
export function isModelBlockedByBrand(modelName: string, rules: KeywordRule[]): boolean {
  const lower = modelName.trim().toLowerCase();
  if (!lower || rules.length === 0) return false;
  const segments = getSegments(lower);
  return rules.some((rule) => matchesRule(lower, segments, rule));
}
