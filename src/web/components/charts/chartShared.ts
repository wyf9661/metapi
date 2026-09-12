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
// Softened to sit next to the muted brand accent instead of shouting over it.
const LOW = { r: 203, g: 70, b: 68 };
const MID = { r: 215, g: 150, b: 40 };
const HIGH = { r: 38, g: 143, b: 79 };  // healthy = green (explicitly not the brand accent)  // theme success — healthy is green, not the brand accent

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
// Category palette  (pie / trend series)
// One harmonised wheel: equal lightness (0.62) and chroma (0.095), 16 hues in
// 22.5-degree steps starting at the brand accent, so no series shouts louder than
// the others and the old amber/red cast no longer fights the cyan theme.
// One source of truth so a new chart can never ship the old saturated set.
// ----------------------------------------------------------------
export const CHART_CATEGORY_PALETTE = [
  '#3194ab', '#4a8eb9', '#6586c0', '#7f7ebe',
  '#9477b4', '#a671a3', '#b26e8d', '#b86d75',
  '#b8715e', '#b17749', '#a3803e', '#908940',
  '#78914f', '#5c9666', '#3f997e', '#2a9896',
];

// ----------------------------------------------------------------
// Horizontal bar gradients  (spend / tokens / calls)
// Straight from the logo's three colours: #0d9488 (core + source nodes),
// #14b8a6 (the converging strokes) and #06b6d4 (core top).
// ----------------------------------------------------------------
export const CHART_BAR_GRADIENTS = {
  spend: { from: '#14b8a6', to: '#06b6d4' },
  tokens: { from: '#0d9488', to: '#06b6d4' },
  calls: { from: '#14b8a6', to: '#0d9488' },
};

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
      // Same rows on both tooltip modes; the default dimension tooltip used to
      // print raw model names and unformatted numbers.
      mark: {
        content: [
          {
            key: (datum: Record<string, unknown>) => String(datum?.model ?? ''),
            value: (datum: Record<string, unknown>) => formatLabel(Number(datum?.value ?? 0)),
          },
        ],
      },
      dimension: {
        content: [
          {
            key: (datum: Record<string, unknown>) => String(datum?.model ?? ''),
            value: (datum: Record<string, unknown>) => formatLabel(Number(datum?.value ?? 0)),
          },
        ],
      },
      className: CHART_TOOLTIP_CLASS,
      trigger: (isMobile ? 'click' : 'hover') as 'click' | 'hover',
      triggerOff: (isMobile ? 'click' : 'hover') as 'click' | 'hover',
      lockAfterClick: isMobile,
    },
    animation: true,
    background: 'transparent',
  };
}