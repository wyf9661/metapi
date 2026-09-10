import React from 'react';

export type StatusTone = 'success' | 'danger' | 'warning' | 'info' | 'muted';

const TONE_COLORS: Record<StatusTone, string> = {
  success: 'var(--color-success)',
  danger: 'var(--color-danger)',
  warning: 'var(--color-warning)',
  info: 'var(--color-info)',
  muted: 'var(--color-text-muted)',
};

/**
 * Map a legacy `badge-*` class onto a tone so call sites can keep the label /
 * class logic they already have and only swap the rendering.
 */
export function statusToneFromBadgeClass(badgeClass?: string | null): StatusTone {
  const name = String(badgeClass || '')
    .trim()
    .replace(/^badge\s+/, '')
    .replace(/^badge-/, '');
  switch (name) {
    case 'success':
      return 'success';
    case 'error':
    case 'danger':
      return 'danger';
    case 'warning':
      return 'warning';
    case 'info':
    case 'primary':
      return 'info';
    default:
      return 'muted';
  }
}

export function statusToneColor(tone: StatusTone): string {
  return TONE_COLORS[tone];
}

/**
 * Status text for dense tables: colour and weight only, no filled chip.
 *
 * A chip carries padding and a border, so it sits on a different baseline and
 * changes glyph height — which breaks vertical alignment the moment one row in a
 * column differs (e.g. "有重试" next to "无重试", or one coloured status among
 * grey ones). Colour alone already carries the meaning, and the column stops
 * looking like a colour chart when every row repeats the same value.
 */
export type StatusTextProps = {
  tone?: StatusTone;
  /** Legacy `badge-success` / `badge-error` / … class, converted to a tone. */
  badgeClass?: string | null;
  children: React.ReactNode;
  /** Force the 600 weight; danger is bolded automatically. */
  bold?: boolean;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'className' | 'children'>;

export function StatusText({
  tone,
  badgeClass,
  children,
  bold,
  style,
  ...rest
}: StatusTextProps) {
  const resolved = tone ?? statusToneFromBadgeClass(badgeClass);
  const emphasized = bold === true || resolved === 'danger';
  return (
    <span
      {...rest}
      style={{
        color: statusToneColor(resolved),
        fontWeight: emphasized ? 600 : 500,
        fontSize: 12,
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/**
 * Metric readout in the same shape as the usage log's timing column: a thin
 * coloured bar plus a muted label and a coloured value. Used where a number has
 * a "better/worse" scale (latency, throughput, success rate) so those figures
 * read the same everywhere instead of turning into filled chips.
 */
export function MetricIndicator({
  label,
  value,
  tone,
  badgeClass,
  title,
}: {
  /** Muted caption shown before the value; omit inside a table cell that already has a header. */
  label?: React.ReactNode;
  value: React.ReactNode;
  tone?: StatusTone;
  badgeClass?: string | null;
  title?: string;
}) {
  const resolved = tone ?? statusToneFromBadgeClass(badgeClass);
  const color = statusToneColor(resolved);
  return (
    <span
      data-tooltip={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 4,
          height: 14,
          flexShrink: 0,
          borderRadius: 9999,
          background: color,
        }}
      />
      {label ? <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>{label}</span> : null}
      <span
        style={{
          color,
          fontWeight: 500,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </span>
  );
}

/**
 * Outlined status pill: same colour language as StatusText, but with a hairline
 * border instead of a fill. Used where a column needs a visible boundary
 * (sites status / health) without the weight of a filled badge.
 */
export function StatusPill({
  tone,
  badgeClass,
  children,
  bold,
  style,
  ...rest
}: StatusTextProps) {
  const resolved = tone ?? statusToneFromBadgeClass(badgeClass);
  const color = statusToneColor(resolved);
  const emphasized = bold === true || resolved === 'danger';
  return (
    <span
      {...rest}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 6,
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        background: 'transparent',
        color,
        fontSize: 12,
        fontWeight: emphasized ? 600 : 500,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
