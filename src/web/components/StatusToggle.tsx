import React from 'react';

/**
 * The single toggle behind every "is this on" switch (route enabled, account
 * check-in). It previously existed twice — `route-enable-toggle` and
 * `checkin-toggle-badge` — which is exactly how the two drifted apart; one
 * component means a restyle cannot miss a caller.
 */
type StatusToggleProps = {
  enabled: boolean;
  onLabel?: React.ReactNode;
  offLabel?: React.ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  busy?: boolean;
  tooltipOn?: string;
  tooltipOff?: string;
  style?: React.CSSProperties;
};

export function StatusToggle({
  enabled,
  onLabel = '启用',
  offLabel = '禁用',
  onClick,
  disabled,
  busy,
  tooltipOn,
  tooltipOff,
  style,
}: StatusToggleProps) {
  const tooltip = enabled ? tooltipOn : tooltipOff;
  return (
    <button
      type="button"
      className={`status-toggle ${enabled ? 'is-on' : 'is-off'}`}
      onClick={onClick}
      disabled={Boolean(disabled) || Boolean(busy)}
      data-tooltip={tooltip}
      aria-label={tooltip}
      style={style}
    >
      {busy ? <span className="spinner spinner-sm" /> : (enabled ? onLabel : offLabel)}
    </button>
  );
}
