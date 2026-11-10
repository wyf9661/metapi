import { useEffect, useState, type CSSProperties } from 'react';
import ActualModelTrigger from './ActualModelTrigger.js';
import { buildFaviconUrl } from './siteFavicon.js';
import {
  avatarLetters,
  brandBadgeColors,
  brandIconBadgeColor,
  clampBadgeColor,
  getBrand,
  getBrandIconUrl,
  hashColor,
  normalizeBrandIconKey,
  type BrandInfo,
} from './brandRegistry.js';

export type { BrandInfo } from './brandRegistry.js';
export {
  brandBadgeColors,
  brandIconBadgeColor,
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
  brand?: (Pick<BrandInfo, 'name' | 'icon' | 'modelIcon'> & { color?: string | null }) | null;
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

  // Two attempts, then the letter glyph: the mark itself, and — when the model
  // has no known vendor — the upstream site's favicon. Both can miss (a brand
  // outside the icon set, a site whose favicon the server cannot fetch), and a
  // blank slot is worse than the brand's initial.
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

  // Letter fallback keeps the same hue the glyph would have had.
  const fallbackBase = resolvedBrand
    ? brandIconBadgeColor([resolvedBrand.modelIcon, resolvedBrand.icon], resolvedBrand.color) ?? resolvedBrand.color
    : null;

  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        // No fill: icons read as glyphs, not as coloured tiles, but the brand
        // hue stays in the text (clamped per theme so it stays legible).
        background: 'transparent',
        color: fallbackBase ? clampBadgeColor(fallbackBase, cdn) : 'var(--color-text-primary)',
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
  const cdn = useIconCdn();

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
        <BrandGlyph brand={brand} icon={brand.modelIcon || undefined} size={size} fallbackText={brand.name} />
      </div>
    );
  }

  return (
    <div className="model-card-avatar" style={{ width: size, height: size, fontSize: size > 32 ? 16 : 10, color: clampBadgeColor(hashColor(model).text, cdn) }}>
      {avatarLetters(model)}
    </div>
  );
}

export type SiteIconFallback = { name?: string | null; url?: string | null; id?: number | null };

/**
 * Last-resort icon for a model whose vendor we do not recognise yet: borrow the
 * upstream site's own icon. Every configured site already serves a favicon the
 * server discovers, validates and caches, so a vendor nobody has catalogued yet
 * still gets a real icon — no per-brand entry needed here. When the favicon is
 * unavailable the glyph falls back to the label's initial, never to a blank.
 */
function SiteIconGlyph({ site, size, fallbackText }: { site?: SiteIconFallback | null; size: number; fallbackText?: string | null }) {
  const src = buildFaviconUrl(site?.url, site?.id);
  const cdn = useIconCdn();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [src]);

  // No favicon (or it failed): still render the site/model initial instead of a
  // blank slot — the label's first letter is the last-resort identity.
  if (!src || failed) {
    const label = String(fallbackText || site?.name || '').trim();
    const letter = label.replace(/[-_/.\s]/g, '').charAt(0).toUpperCase() || '?';
    return (
      <span
        aria-hidden="true"
        style={{
          width: size, height: size, borderRadius: 4, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          fontSize: Math.max(9, Math.round(size * 0.5)), fontWeight: 700, lineHeight: 1,
          color: clampBadgeColor(hashColor(label || 'site').text, cdn),
        }}
      >
        {letter}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      ref={(el) => { if (el?.complete) setLoaded(true); }}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      style={{
        width: size, height: size, borderRadius: 4, objectFit: 'contain',
        flexShrink: 0, display: 'inline-block',
        // Fade in once loaded so the placeholder never flashes on a dark theme.
        opacity: loaded ? 1 : 0,
        transition: 'opacity 0.15s ease',
      }}
    />
  );
}

/**
 * Model slot: the mark for THIS model. Falls back to the vendor mark when the
 * family has no logo of its own (Moonshot keeps `moonshot`, kimi-* shows Kimi).
 */
export function InlineBrandIcon({ model, size = 16, site }: { model: string; size?: number; site?: SiteIconFallback | null }) {
  const brand = getBrand(model);
  if (brand) return <BrandGlyph brand={brand} icon={brand.modelIcon || undefined} size={size} fallbackText={brand.name} />;
  return <SiteIconGlyph site={site} size={size} fallbackText={model} />;
}

export function ModelBadge({
  model,
  actualModel,
  responseModel,
  style,
  site,
}: {
  model: string;
  actualModel?: string | null;
  /** The model the upstream itself reported in its response body. */
  responseModel?: string | null;
  style?: CSSProperties;
  /** Upstream site the model came from, used as the icon fallback for vendors we do not classify yet. */
  site?: SiteIconFallback | null;
}) {
  const brand = getBrand(model);
  const cdn = useIconCdn();
  // Pass the model name as the perturbation seed so models sharing a brand
  // colour (e.g. multiple DeepSeek/GPT models) still get distinct badges.
  // Tint the chip with the model slot's own mark (Kimi blue, Claude orange …);
  // mono marks fall back to the hand-written brand colour.
  const colors = brandBadgeColors(
    brandIconBadgeColor([brand?.modelIcon, brand?.icon], brand?.color),
    cdn as 'dark' | 'light',
    model,
  );

  return (
    // The route glyph lives OUTSIDE the chip: the chip keeps the geometry it has
    // everywhere else (its asymmetric padding is tuned for the brand icon plus
    // the label), and the glyph reads as an annotation about the model rather
    // than part of its name.
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...style }}>
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 10px 2px 6px',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        fontWeight: 500,
        background: 'transparent',
        color: colors.text,
        border: `1px solid ${colors.border}`,
        whiteSpace: 'nowrap',
      }}
      >
        <InlineBrandIcon model={model} size={14} site={site} />
        {model}
      </span>
      <ActualModelTrigger requestedModel={model} actualModel={actualModel} responseModel={responseModel} />
    </span>
  );
}
