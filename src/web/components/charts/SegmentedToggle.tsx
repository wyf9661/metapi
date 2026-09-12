import type { CSSProperties, ReactNode } from 'react';

// One segmented-control style shared by every small toggle group in the chart
// panels (distribution mode, trend metric, trend range) so both chart views
// stay visually consistent when switching tabs.

const groupStyle: CSSProperties = {
  display: 'inline-flex',
  gap: 0,
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border)',
  overflow: 'hidden',
  maxWidth: '100%',
};

const buttonBaseStyle: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  border: 'none',
  transition: 'all 0.2s ease',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

const activeStyle: CSSProperties = {
  background: 'var(--color-primary)',
  color: '#ffffff',
};

const inactiveStyle: CSSProperties = {
  background: 'var(--color-bg-card)',
  color: 'var(--color-text-secondary)',
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
  return (
    <div style={{ ...groupStyle, ...style }}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          style={{
            ...buttonBaseStyle,
            ...(option.key === value ? activeStyle : inactiveStyle),
          }}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}
