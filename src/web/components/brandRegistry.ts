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
  '#e0e7ff', '#dbeafe', '#fce7f3', '#fef3c7',
  '#d1fae5', '#e0f2fe', '#edf2ff', '#f5f3ff',
];

const FALLBACK_FOREGROUNDS = [
  '#4338ca', '#1d4ed8', '#be185d', '#b45309',
  '#047857', '#0369a1', '#2563eb', '#6d28d9',
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
  // `cdn` carries the resolved theme ('dark' | 'light'); brand icons are proxied
  // through our own origin so one server-side cache serves every client.
  const theme = cdn === 'dark' ? 'dark' : 'light';
  return `/api/brand-icon?icon=${encodeURIComponent(normalized)}&theme=${theme}`;
}

export function hashColor(name: string): { bg: string; text: string } {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % FALLBACK_COLORS.length;
  return { bg: FALLBACK_COLORS[idx]!, text: FALLBACK_FOREGROUNDS[idx]! };
}

/** Deterministic per-name hash in [0, 1), salted so hue/luma channels differ. */
function nameHash(name: string, salt: string): number {
  const input = `${salt}:${name}`;
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) | 0;
  return (Math.abs(h) % 10000) / 10000;
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hn = ((h % 360) + 360) % 360 / 360;
  if (s === 0) {
    const v = clampChannel(l * 255);
    return toHex({ r: v, g: v, b: v });
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return toHex({
    r: channel(hn + 1 / 3) * 255,
    g: channel(hn) * 255,
    b: channel(hn - 1 / 3) * 255,
  });
}

/**
 * Nudge a base colour with a per-name hash so sites/models that share the same
 * icon or brand colour still get distinguishable badges. Hue moves within ±20°
 * (same colour family), luminance ±5%. Grayscale colours (black logos) get a
 * luminance-only nudge so every same-icon site still differs while staying
 * black-family. The result is then theme-clamped for readability.
 */
export function perturbBadgeColor(hex: string, name: string, theme: 'dark' | 'light'): string {
  const rgb = hexToRgb(hex);
  if (!rgb || !name) return clampBadgeColor(hex, theme);
  const isGray = rgb.r === rgb.g && rgb.g === rgb.b;
  let shifted: string;
  if (isGray) {
    const scale = 1 + (nameHash(name, 'luma') - 0.5) * 0.22;
    shifted = toHex({ r: rgb.r * scale, g: rgb.g * scale, b: rgb.b * scale });
  } else {
    const [h, s, l] = rgbToHsl(rgb);
    const dh = (nameHash(name, 'hue') - 0.5) * 40;
    const dl = (nameHash(name, 'luma') - 0.5) * 0.1;
    shifted = hslToHex(h + dh, s, Math.max(0, Math.min(1, l * (1 + dl))));
  }
  return clampBadgeColor(shifted, theme);
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
 * Clamp a colour's perceived luminance for use as badge text:
 * - light theme: keep it dark-ish ([0.15, 0.40]) so text reads on pale tints
 * - dark theme: keep it bright-ish ([0.45, 0.8]) so text reads on dark cards
 * Black logos (e.g. DeepSeek's #000 SVG) therefore stay black-family in light
 * mode and lift to a readable grey in dark mode.
 */
export function clampBadgeColor(hex: string, theme: 'dark' | 'light'): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  let { r, g, b } = rgb;
  const lum = relativeLuminance(rgb);
  if (theme === 'dark') {
    if (lum < 0.45) {
      const scale = (1 - 0.45) / (1 - lum);
      r = Math.round(255 - (255 - r) * scale);
      g = Math.round(255 - (255 - g) * scale);
      b = Math.round(255 - (255 - b) * scale);
    } else if (lum > 0.8) {
      const scale = 0.8 / lum;
      r = Math.round(r * scale); g = Math.round(g * scale); b = Math.round(b * scale);
    }
  } else {
    if (lum > 0.40) {
      const scale = 0.40 / lum;
      r = Math.round(r * scale); g = Math.round(g * scale); b = Math.round(b * scale);
    } else if (lum < 0.15) {
      const scale = (1 - 0.15) / (1 - lum);
      r = Math.round(255 - (255 - r) * scale);
      g = Math.round(255 - (255 - g) * scale);
      b = Math.round(255 - (255 - b) * scale);
    }
  }
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * Derive badge fill/border/text colors from a brand's own color so every brand
 * stays visually consistent with its icon instead of falling back to one shared
 * theme tint. Text is tuned for the current theme so the label stays readable
 * against the card background either way.
 */
export function brandBadgeColors(
  color: string | null | undefined,
  theme?: 'dark' | 'light',
  name?: string,
): BrandBadgeColors {
  const rgb = hexToRgb(color ?? '');
  if (!rgb) return DEFAULT_BADGE_COLORS;

  const hex = toHex(rgb);
  const text = name ? perturbBadgeColor(hex, name, theme ?? 'light') : clampBadgeColor(hex, theme ?? 'light');
  // Base fill/border on the same (possibly perturbed) hue so every name gets
  // its own tint, not just its own label colour.
  const fillRgb = hexToRgb(text) ?? rgb;

  return {
    bg: `rgba(${fillRgb.r},${fillRgb.g},${fillRgb.b},0.12)`,
    border: `rgba(${fillRgb.r},${fillRgb.g},${fillRgb.b},0.25)`,
    text,
  };
}

export function avatarLetters(name: string): string {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '?';
  // Single character only: two-letter blocks read as noise next to real logos.
  const firstMeaningful = trimmed.replace(/[-_/.\s]/g, '').charAt(0);
  return (firstMeaningful || trimmed.charAt(0)).toUpperCase();
}
