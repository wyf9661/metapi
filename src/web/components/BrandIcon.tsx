import { useEffect, useState, type CSSProperties } from 'react';
import {
  avatarLetters,
  brandBadgeColors,
  getBrand,
  getBrandIconUrl,
  hashColor,
  normalizeBrandIconKey,
  type BrandInfo,
} from './brandRegistry.js';

export type { BrandInfo } from './brandRegistry.js';
export {
  brandBadgeColors,
  clampBadgeColor,
  getBrand,
  getBrandIconUrl,
  hashColor,
  normalizeBrandIconKey,
  perturbBadgeColor,
} from './brandRegistry.js';

const BRAND_ICON_THEME_DARK = 'dark';
const BRAND_ICON_THEME_LIGHT = 'light';

export function useIconCdn() {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.getAttribute('data-theme') === 'dark';
  });
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.getAttribute('data-theme') === 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return isDark ? BRAND_ICON_THEME_DARK : BRAND_ICON_THEME_LIGHT;
}

type BrandGlyphProps = {
  brand?: Pick<BrandInfo, 'name' | 'icon'> | null;
  model?: string | null;
  icon?: string | null;
  alt?: string;
  size?: number;
  fallbackText?: string | null;
  style?: CSSProperties;
};

export function BrandGlyph({ brand, model, icon, alt, size = 16, fallbackText, style }: BrandGlyphProps) {
  const cdn = useIconCdn();
  const resolvedBrand = brand || (model ? getBrand(model) : null);
  const resolvedIcon = normalizeBrandIconKey(icon || resolvedBrand?.icon || null);
  const [imgError, setImgError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);

  useEffect(() => {
    setImgError(false);
    setImgLoaded(false);
  }, [resolvedIcon]);

  if (resolvedIcon && !imgError) {
    const src = getBrandIconUrl(resolvedIcon, cdn);
    if (src) {
      return (
        <img
          src={src}
          alt={alt || resolvedBrand?.name || model || 'brand'}
          // Use a callback ref so cached images (which may fire `onLoad` before
          // React attaches the synthetic handler) still get their opacity set.
          ref={(el) => { if (el?.complete) setImgLoaded(true); }}
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgError(true)}
          style={{
            width: size,
            height: size,
            objectFit: 'contain',
            flexShrink: 0,
            verticalAlign: 'middle',
            // Fade in once loaded: prevents the browser's blank/white image
            // placeholder flashing on a dark theme before the icon arrives.
            opacity: imgLoaded ? 1 : 0,
            transition: 'opacity 0.15s ease',
            ...style,
          }}
        />
      );
    }
  }

  const fallback = (fallbackText ?? resolvedBrand?.name ?? model ?? '').trim();
  if (!fallback) return null;

  const { bg: fbBg, text: fbText } = hashColor(fallback);
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: size <= 14 ? 4 : size <= 20 ? 6 : 8,
        background: fbBg,
        color: fbText,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.max(9, Math.round(size * 0.5)),
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
        ...style,
      }}
    >
      {fallback}
    </span>
  );
}

export function BrandIcon({ model, size = 44 }: { model: string; size?: number }) {
  const brand = getBrand(model);

  if (brand) {
    return (
      <div style={{
        width: size,
        height: size,
        borderRadius: 'var(--radius-md)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        background: 'transparent',
      }}
      >
        <BrandGlyph brand={brand} size={size} fallbackText={brand.name} />
      </div>
    );
  }

  return (
    <div className="model-card-avatar" style={{ width: size, height: size, background: hashColor(model).bg, fontSize: size > 32 ? 16 : 10 }}>
      {avatarLetters(model)}
    </div>
  );
}

export function InlineBrandIcon({ model, size = 16 }: { model: string; size?: number }) {
  const brand = getBrand(model);
  if (!brand) return null;
  return <BrandGlyph brand={brand} size={size} fallbackText={brand.name} />;
}

export function ModelBadge({ model, style }: { model: string; style?: CSSProperties }) {
  const brand = getBrand(model);
  const cdn = useIconCdn();
  // Pass the model name as the perturbation seed so models sharing a brand
  // colour (e.g. multiple DeepSeek/GPT models) still get distinct badges.
  const colors = brandBadgeColors(brand?.color, cdn as 'dark' | 'light', model);

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '2px 10px 2px 6px',
      borderRadius: 'var(--radius-sm)',
      fontSize: 12,
      fontWeight: 500,
      background: colors.bg,
      color: colors.text,
      border: `1px solid ${colors.border}`,
      whiteSpace: 'nowrap',
      ...style,
    }}
    >
      <InlineBrandIcon model={model} size={14} />
      {model}
    </span>
  );
}
