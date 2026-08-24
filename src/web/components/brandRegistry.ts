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
  'linear-gradient(135deg, #0f766e, #14b8a6)',
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

export type BrandBadgeColors = {
  bg: string;
  border: string;
  text: string;
};

const DEFAULT_BADGE_COLORS: BrandBadgeColors = {
  bg: 'var(--color-primary-light)',
  border: 'rgba(79,70,229,0.15)',
  text: 'var(--color-primary)',
};

/** Pull the first hex color out of a brand gradient/color string. */
function firstHexColor(color: string | null | undefined): string | null {
  const match = /#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(String(color || ''));
  if (!match) return null;
  const hex = match[1]!;
  if (hex.length === 3) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase();
  }
  return `#${hex.toLowerCase()}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = firstHexColor(hex);
  if (!normalized) return null;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

/** Perceived luminance (0..1) using the sRGB coefficients. */
function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const pair = (value: number) => clampChannel(value).toString(16).padStart(2, '0');
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/**
 * Derive badge fill/border/text colors from a brand's own color so every brand
 * stays visually consistent with its icon instead of falling back to one shared
 * theme tint. Very light brand colors get darkened for readable label text.
 */
export function brandBadgeColors(color: string | null | undefined): BrandBadgeColors {
  const rgb = hexToRgb(color ?? '');
  if (!rgb) return DEFAULT_BADGE_COLORS;

  const luminance = relativeLuminance(rgb);
  // Keep label text readable on the translucent tint: darken bright brand
  // colors (e.g. NVIDIA green, Anthropic sand) toward a legible shade.
  const darkenFactor = luminance > 0.72 ? 0.5 : luminance > 0.55 ? 0.68 : 1;
  const text = darkenFactor === 1
    ? toHex(rgb)
    : toHex({
      r: rgb.r * darkenFactor,
      g: rgb.g * darkenFactor,
      b: rgb.b * darkenFactor,
    });

  return {
    bg: `rgba(${rgb.r},${rgb.g},${rgb.b},0.08)`,
    border: `rgba(${rgb.r},${rgb.g},${rgb.b},0.2)`,
    text,
  };
}

export function avatarLetters(name: string): string {
  const parts = name.replace(/[-_/.]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
