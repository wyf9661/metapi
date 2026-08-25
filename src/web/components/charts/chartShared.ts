// shared chart-building utilities for the Metapi dashboard.
// Keeps bar-spec configuration (headroom, corner-radius, tooltip semantics) in
// one place so changes apply to every chart and don't need shotgun edits.

// ----------------------------------------------------------------
// Radius / corner tokens  (VChart uses numeric pixel values, not CSS vars)
// ----------------------------------------------------------------
export const BAR_CORNER_RADIUS: [number, number, number, number] = [0, 6, 6, 0];
export const CHART_TOOLTIP_CLASS = 'chart-tooltip';

// ----------------------------------------------------------------
// Horizontal bar headroom   (right side of the longest bar)
// ----------------------------------------------------------------
export function barHeadroom(isMobile: boolean): number {
  return isMobile ? 1.55 : 1.18;
}

// ----------------------------------------------------------------
// Availability colour palette  (red → amber → teal-green)
// Shared with the dashboard "24h availability" strip.
// ----------------------------------------------------------------
const LOW = { r: 190, g: 39, b: 52 };
const MID = { r: 194, g: 132, b: 20 };
const HIGH = { r: 13, g: 138, b: 116 };

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** 0..100 → {r, g, b}. Throws if value is NaN or out-of-range. */
export function availabilityRgb(value: number): { r: number; g: number; b: number } {
  const clamped = Math.max(0, Math.min(100, value));
  if (clamped <= 50) {
    const t = clamped / 50;
    return {
      r: lerpChannel(LOW.r, MID.r, t),
      g: lerpChannel(LOW.g, MID.g, t),
      b: lerpChannel(LOW.b, MID.b, t),
    };
  }
  const t = (clamped - 50) / 50;
  return {
    r: lerpChannel(MID.r, HIGH.r, t),
    g: lerpChannel(MID.g, HIGH.g, t),
    b: lerpChannel(MID.b, HIGH.b, t),
  };
}

/** Same as availabilityRgb but returns a CSS rgb() string.
 *  null / undefined / NaN → 'transparent' (mirrors the old Dashboard helper). */
export function availabilityColor(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return 'transparent';
  }
  const c = availabilityRgb(value);
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

// ----------------------------------------------------------------
// Build a horizontal-bar VChart spec shared by the model analysis
// panel (spend / trend / calls) and the site-balance chart.
// ----------------------------------------------------------------
export interface BarChartSpecInput {
  values: Array<{ model: string; value: number }>;
  /** Gradient fill start colour (hex). */
  gradientFrom: string;
  /** Gradient fill end colour (hex). */
  gradientTo: string;
  formatLabel: (v: number) => string;
  labelColor: string;
  isMobile: boolean;
}

export function buildHorizontalBarSpec({
  values,
  gradientFrom,
  gradientTo,
  formatLabel,
  labelColor,
  isMobile,
}: BarChartSpecInput): any {
  const maxValue = values.reduce((s, d) => Math.max(s, d.value), 0);
  const headroom = barHeadroom(isMobile);
  return {
    type: 'bar' as const,
    data: [{ id: 'data', values }],
    xField: 'value',
    yField: 'model',
    direction: 'horizontal' as const,
    bar: {
      style: {
        cornerRadius: BAR_CORNER_RADIUS,
        fill: {
          gradient: 'linear' as const,
          x0: 0, y0: 0, x1: 1, y1: 0,
          stops: [
            { offset: 0, color: gradientFrom },
            { offset: 1, color: gradientTo },
          ],
        },
      },
    },
    label: {
      visible: true,
      position: 'right',
      formatMethod: (text: string | number) => formatLabel(Number(text)),
      style: { fontSize: 11, fill: labelColor, stroke: 'transparent' },
    },
    axes: [
      {
        orient: 'left',
        label: { style: { fontSize: 11, fill: labelColor, maxWidth: 160, overflow: 'truncate' } },
      },
      {
        orient: 'bottom',
        visible: false,
        max: Math.ceil(maxValue * headroom),
      },
    ],
    tooltip: {
      className: CHART_TOOLTIP_CLASS,
      trigger: (isMobile ? 'click' : 'hover') as 'click' | 'hover',
      triggerOff: (isMobile ? 'click' : 'hover') as 'click' | 'hover',
      lockAfterClick: isMobile,
    },
    animation: true,
    background: 'transparent',
  };
}