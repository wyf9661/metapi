import type { CSSProperties, ReactNode } from 'react';
import { getEffectiveTheme } from './chartShared.js';

// Honor MagicOS system-level force-dark flattens EVERY CSS-based paint —
// including `background-image` URL(data:image/svg+xml) — into the card color:
// we proved that with the user's phone (toggle regions stayed pure card bg
// even with the SVG background-image fix).  What DOES pass through unchanged
// is <img> element content (the logo <img> keeps its teal hue under
// force-dark) and canvas.  So the active segment's fill is painted as an
// absolutely-positioned <img>, exactly like the pill-tab active chip.

// Active chip fill — same values as PillTabBg, so a segmented control and a
// pill-tab group sitting in the same card look identical in both themes.
const ACTIVE_FILL_LIGHT = '#fdfcfa';
const ACTIVE_FILL_DARK = '#5d6564';

function segmentImgUri(hex: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="${hex}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const buttonBaseStyle: CSSProperties = {
  position: 'relative',
  zIndex: 0,
  overflow: 'hidden',
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--color-text-muted)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  border: 'none',
  background: 'none',
  transition: 'color 0.2s ease, opacity 0.2s ease',
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

  // Same track treatment as .pill-tabs: a light-grey (dark: translucent
  // white) well holding a raised chip for the selected segment.
  const groupStyle: CSSProperties = {
    display: 'inline-flex',
    gap: 2,
    padding: 3,
    borderRadius: 'var(--radius-md)',
    background: dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
    maxWidth: '100%',
    overflowX: 'auto',
  };

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
              fontWeight: isActive ? 600 : 500,
              ...(isActive
                ? {
                    color: dark
                      ? 'var(--color-text-primary)'
                      : 'var(--color-primary)',
                  }
                : null),
            }}
          >
            {isActive && (
              <img
                src={segmentImgUri(dark ? ACTIVE_FILL_DARK : ACTIVE_FILL_LIGHT)}
                alt=""
                style={bgImgStyle}
              />
            )}
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}