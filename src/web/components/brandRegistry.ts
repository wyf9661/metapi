export {
  collectBrandCandidates,
  getAllBrandNames,
  getAllBrands,
  getBrand,
  stripCommonWrappers,
  type BrandInfo,
  type BrandMatchContext,
} from '../../server/shared/modelBrand.js';

const LEGACY_ICON_ALIASES: Record<string, string> = {
  anthropic: 'claude-color',
  'claude.color': 'claude-color',
  'cohere.color': 'cohere-color',
  'doubao.color': 'doubao-color',
  'gemini.color': 'gemini-color',
  'hunyuan.color': 'hunyuan-color',
  meta: 'meta-color',
  'meta-brand-color': 'meta-color',
  'minimax.color': 'minimax-color',
  'qwen.color': 'qwen-color',
  'spark.color': 'spark-color',
  stability: 'stability-color',
  'stability-brand-color': 'stability-color',
  stepfun: 'stepfun-color',
  'wenxin.color': 'wenxin-color',
  xai: 'xai',
  'yi.color': 'yi-color',
  'zhipu.color': 'zhipu-color',
  azure: 'microsoft-color',
  'bytedance-brand-color': 'bytedance-color',
  kilo: 'kilocode',
  'kilo-color': 'kilocode',
  'opencode-color': 'opencode',
};

function normalizeInput(value: string): string {
  return String(value || '').trim().toLowerCase();
}

const FALLBACK_COLORS = [
  'linear-gradient(135deg, #4f46e5, #818cf8)',
  'linear-gradient(135deg, #059669, #34d399)',
  'linear-gradient(135deg, #2563eb, #60a5fa)',
  'linear-gradient(135deg, #d946ef, #f0abfc)',
  'linear-gradient(135deg, #ea580c, #fb923c)',
  'linear-gradient(135deg, #0891b2, #22d3ee)',
  'linear-gradient(135deg, #7c3aed, #a78bfa)',
  'linear-gradient(135deg, #dc2626, #f87171)',
];

/** Absolute icon URLs for brands missing from the shared icon CDN. */
const CUSTOM_BRAND_ICON_URLS: Record<string, string> = {
  agnes: 'https://agnes-ai.com/images/biglogo.png',
};

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function normalizeBrandIconKey(icon: string | null | undefined): string | null {
  const raw = String(icon || '').trim();
  if (!raw) return null;
  // Preserve absolute URLs so brands can ship custom logos.
  if (isAbsoluteHttpUrl(raw)) return raw;
  const normalized = normalizeInput(raw).replace(/\./g, '-');
  if (!normalized) return null;
  return LEGACY_ICON_ALIASES[normalized] || normalized;
}

export function getBrandIconUrl(icon: string | null | undefined, cdn: string): string | null {
  const normalized = normalizeBrandIconKey(icon);
  if (!normalized) return null;
  if (isAbsoluteHttpUrl(normalized)) return normalized;
  const custom = CUSTOM_BRAND_ICON_URLS[normalized];
  if (custom) return custom;
  return `${cdn}/${normalized}.png`;
}

export function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length]!;
}

export function avatarLetters(name: string): string {
  const parts = name.replace(/[-_/.]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
