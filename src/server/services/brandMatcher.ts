/**
 * Server-side brand matching for global brand filtering.
 *
 * Brand keywords are extracted from the frontend BrandIcon.tsx BRAND_DEFINITIONS.
 * Each brand maps to a set of keywords that, when found in a model name, identify
 * the model as belonging to that brand.
 */

const BRAND_KEYWORDS: Record<string, string[]> = {
  'OpenAI': ['gpt', 'chatgpt', 'dall-e', 'whisper', 'text-embedding', 'text-moderation', 'davinci', 'babbage', 'codex-mini', 'o1', 'o3', 'o4', 'tts'],
  'Anthropic': ['claude'],
  'Google': ['gemini', 'gemma', 'palm', 'paligemma', 'shieldgemma', 'recurrentgemma', 'deplot', 'codegemma', 'imagen', 'learnlm', 'aqa', 'veo'],
  'DeepSeek': ['deepseek', 'ds-chat'],
  '通义千问': ['qwen', 'qwq', 'tongyi'],
  '智谱 AI': ['glm', 'chatglm', 'codegeex', 'cogview', 'cogvideo'],
  'Meta': ['llama', 'code-llama', 'codellama'],
  'Mistral': ['mistral', 'mixtral', 'codestral', 'pixtral', 'ministral', 'voxtral', 'magistral'],
  'Moonshot': ['moonshot', 'kimi'],
  '零一万物': ['yi-'],
  '文心一言': ['ernie', 'eb-'],
  '讯飞星火': ['spark', 'generalv'],
  '腾讯混元': ['hunyuan', 'tencent-hunyuan'],
  '豆包': ['doubao'],
  'MiniMax': ['minimax', 'abab'],
  'Cohere': ['command', 'c4ai-'],
  'Microsoft': ['phi-', 'kosmos'],
  'xAI': ['grok'],
  '阶跃星辰': ['stepfun', 'step-'],
  'Stability': ['flux', 'stablediffusion', 'stable-diffusion', 'sdxl', 'sd3'],
  'NVIDIA': ['nemotron', 'nemoretriever', 'neva', 'riva-translate', 'cosmos'],
  'IBM': ['granite'],
  'BAAI': ['bge-'],
  'ByteDance': ['bytedance', 'seed-oss', 'kolors', 'kwai', 'kwaipilot', 'wan-', 'kat-'],
  'InternLM': ['internlm'],
  'Midjourney': ['midjourney', 'mj_'],
  'DeepL': ['deepl-', 'deepl/'],
  'Jina AI': ['jina'],
};

/**
 * Get all available brand names.
 */
export function getAllBrandNames(): string[] {
  return Object.keys(BRAND_KEYWORDS);
}

/**
 * Get the flattened list of keywords for blocked brands.
 */
export function getBlockedModelKeywords(blockedBrands: string[]): string[] {
  const keywords: string[] = [];
  for (const brand of blockedBrands) {
    const brandKeywords = BRAND_KEYWORDS[brand];
    if (brandKeywords) {
      keywords.push(...brandKeywords);
    }
  }
  return keywords;
}

/**
 * Check if a model name matches any of the blocked keywords.
 * Uses a case-insensitive substring match (same approach as frontend BrandIcon).
 */
export function isModelBlockedByBrand(modelName: string, blockedKeywords: string[]): boolean {
  const lower = modelName.trim().toLowerCase();
  if (!lower) return false;
  return blockedKeywords.some((keyword) => lower.includes(keyword));
}
