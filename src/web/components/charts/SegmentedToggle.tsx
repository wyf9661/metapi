import type { CSSProperties, ReactNode } from 'react';
import { getEffectiveTheme } from './chartShared.js';

// Honor MagicOS system-level force-dark flattens EVERY CSS-based paint —
// including `background-image` URL(data:image/svg+xml) — into the card color:
// we proved that with the user's phone (toggle regions stayed pure card bg
// even with the SVG background-image fix).  What DOES pass through unchanged
// is <img> element content (the logo <img> keeps its teal hue under
// force-dark) and canvas.  So segment backgrounds are painted as
// absolutely-positioned <img> elements instead.

const LIGHT_PRIMARY_HEX = '#00727f';
const DARK_PRIMARY_HEX = '#00bace';
const LIGHT_CARD_HEX = '#fdfcfa';
const DARK_CARD_HEX = '#1f2d2c';
// Dark active text — near-black for strong contrast on bright cyan fill
// under ANY system force-dark filter (Honor flattens to gray but lightness
// differences survive).  Contrast = ~7:1.
const ACTIVE_TEXT_DARK = '#142120';

function segmentImgUri(hex: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="${hex}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const groupStyle: CSSProperties = {
  display: 'inline-flex',
  gap: 0,
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border)',
  overflow: 'hidden',
  maxWidth: '100%',
};

const buttonBaseStyle: CSSProperties = {
  position: 'relative',
  zIndex: 0,
  overflow: 'hidden',
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  border: 'none',
  background: 'transparent',
  transition: 'all 0.2s ease',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

const bgImgStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  borderRadius: 'inherit',
  zIndex: -1,
  pointerEvents: 'none',
};

export interface SegmentedOption<T extends string> {
  key: T;
  label: string;
  icon?: ReactNode;
}

export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (key: T) => void;
  style?: CSSProperties;
}) {
  const dark = getEffectiveTheme() === 'dark';
  const primaryHex = dark ? DARK_PRIMARY_HEX : LIGHT_PRIMARY_HEX;
  const cardHex = dark ? DARK_CARD_HEX : LIGHT_CARD_HEX;
  return (
    <div style={{ ...groupStyle, ...style }}>
      {options.map((option) => {
        const isActive = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
            style={{
              ...buttonBaseStyle,
              ...(isActive
                ? { color: dark ? ACTIVE_TEXT_DARK : '#ffffff' }
                : { color: 'var(--color-text-secondary)' }),
            }}
          >
            <img
              src={segmentImgUri(isActive ? primaryHex : cardHex)}
              alt=""
              style={bgImgStyle}
            />
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}