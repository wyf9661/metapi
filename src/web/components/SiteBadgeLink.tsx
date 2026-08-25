import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandGlyph, brandBadgeColors, getBrand, hashColor, perturbBadgeColor, useIconCdn } from './BrandIcon.js';

type SiteBadgeLinkProps = {
  siteId?: number | null;
  siteName?: string | null;
  siteUrl?: string | null;
  className?: string;
  badgeClassName?: string;
  badgeStyle?: React.CSSProperties;
  tone?: 'primary';
};

function buildFaviconUrl(rawUrl?: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `/api/site-favicon?url=${encodeURIComponent(url.origin)}`;
  } catch {
    return null;
  }
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return { r: Number.parseInt(m[1]!, 16), g: Number.parseInt(m[2]!, 16), b: Number.parseInt(m[3]!, 16) };
}

/** Derive the dominant colour + luminance from a loaded favicon. */
function extractDominantColor(img: HTMLImageElement): { color: string; luminance: number } | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 16, 16);
    const { data } = ctx.getImageData(0, 0, 16, 16);

    const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! < 128) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (r > 235 && g > 235 && b > 235) continue;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const entry = buckets.get(key);
      if (entry) { entry.count++; entry.r += r; entry.g += g; entry.b += b; }
      else { buckets.set(key, { count: 1, r, g, b }); }
    }

    let best: { count: number; r: number; g: number; b: number } | null = null;
    for (const entry of buckets.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    if (!best) return null;

    const r = Math.round(best.r / best.count);
    const g = Math.round(best.g / best.count);
    const b = Math.round(best.b / best.count);
    return { color: `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`, luminance: relativeLuminance(r, g, b) };
  } catch {
    return null;
  }
}

export function SiteIcon({
  name,
  size,
  url,
  tone,
  onDominantColor,
}: {
  name: string;
  size: number;
  url?: string | null;
  tone?: 'primary';
  onDominantColor?: (color: string | null) => void;
}) {
  const faviconUrl = buildFaviconUrl(url);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const theme = useIconCdn() as 'dark' | 'light';
  const [faviconLum, setFaviconLum] = useState<number | null>(null);

  // Dark logo on a dark theme: wrap the img in a light background circle so it
  // doesn't vanish (like DeepSeek's website does for its black whale logo).
  const needsLightBg = theme === 'dark' && faviconLum !== null && faviconLum < 0.15;

  if (faviconUrl && !faviconFailed) {
    const img = (
      <img
        src={faviconUrl}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        ref={(el) => { if (el?.complete) setImgLoaded(true); }}
        onError={() => setFaviconFailed(true)}
        onLoad={(event) => {
          setImgLoaded(true);
          const result = extractDominantColor(event.currentTarget);
          if (result) {
            setFaviconLum(result.luminance);
            if (onDominantColor) onDominantColor(result.color);
          } else if (onDominantColor) {
            onDominantColor(null);
          }
        }}
        style={{
          width: size, height: size, borderRadius: 4, objectFit: 'contain', flexShrink: 0, display: 'inline-block',
          // Fade in once loaded: prevents the browser's blank/white image
          // placeholder flashing on a dark theme before the icon arrives.
          opacity: imgLoaded ? 1 : 0,
          transition: 'opacity 0.15s ease',
        }}
      />
    );
    if (needsLightBg) {
      return (
        <span
          style={{
            width: size, height: size, borderRadius: 4, display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            background: 'rgba(255,255,255,0.15)',
          }}
        >
          {img}
        </span>
      );
    }
    return img;
  }

  const brand = getBrand(name);
  if (brand) {
    return <BrandGlyph brand={brand} size={size} fallbackText={brand.name} />;
  }
  const fallback = String(name || '').trim();
  const letter = fallback ? fallback.replace(/[-_/.\s]/g, '').charAt(0).toUpperCase() || '?' : '?';
  const { bg, text } = hashColor(name || 'site');
  const colors = tone === 'primary' ? { bg: text, text: '#fff' } : { bg, text };
  return (
    <span
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: 6,
        background: colors.bg, color: colors.text,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: Math.max(9, Math.round(size * 0.58)), fontWeight: 700,
        lineHeight: 1, flexShrink: 0,
      }}
    >
      {letter}
    </span>
  );
}

export default function SiteBadgeLink({
  siteId, siteName, siteUrl,
  className = 'badge-link', badgeClassName = 'badge badge-info', badgeStyle, tone,
}: SiteBadgeLinkProps) {
  const label = String(siteName || '').trim() || '-';
  const normalizedSiteId = Number(siteId);
  const [faviconColor, setFaviconColor] = useState<string | null>(null);
  const theme = useIconCdn() as 'dark' | 'light';

  let siteColors: { bg: string; text: string; border: string } | null = null;
  if (tone === 'primary' && label !== '-') {
    if (faviconColor) {
      // Use the favicon's own colour (including black) as the badge palette,
      // nudged per-site via the name hash so same-icon sites still differ,
      // then clamped for the current theme so text stays readable.
      const nudged = perturbBadgeColor(faviconColor, label, theme);
      const rgb = hexToRgb(nudged);
      if (rgb) {
        siteColors = {
          bg: `rgba(${rgb.r},${rgb.g},${rgb.b},0.12)`,
          border: `rgba(${rgb.r},${rgb.g},${rgb.b},0.25)`,
          text: nudged,
        };
      }
    }
    if (!siteColors) {
      const brand = getBrand(label);
      if (brand) {
        siteColors = brandBadgeColors(brand.color, theme, label);
      } else {
        const { bg, text } = hashColor(label);
        const rgb = hexToRgb(text);
        const border = rgb ? `rgba(${rgb.r},${rgb.g},${rgb.b},0.25)` : 'rgba(13,148,136,0.18)';
        siteColors = { bg, text, border };
      }
    }
  }

  const badgeClass = !siteColors ? badgeClassName : 'badge';
  const badgeCss: React.CSSProperties = siteColors
    ? { background: siteColors.bg, color: siteColors.text, border: `1px solid ${siteColors.border}` }
    : {};

  const badge = (
    <>
      {label !== '-' && <SiteIcon name={label} size={14} url={siteUrl} tone={tone} onDominantColor={setFaviconColor} />}
      <span style={{ lineHeight: 1.2 }}>{label}</span>
    </>
  );

  const badgeSpan = (
    <span className={badgeClass} style={{ ...badgeCss, ...badgeStyle }}>
      {badge}
    </span>
  );

  if (!Number.isFinite(normalizedSiteId) || normalizedSiteId <= 0) return badgeSpan;

  return (
    <Link to={`/sites?focusSiteId=${Math.trunc(normalizedSiteId)}`} className={className} title={label === '-' ? undefined : label}>
      {badgeSpan}
    </Link>
  );
}
