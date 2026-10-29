/**
 * Chart loading placeholder: a centred spinner over the reserved plot height.
 *
 * The earlier shape-matching skeleton drew a polyline, grid lines and axis
 * stubs that read as real data — an operator could mistake the placeholder for
 * an actual trend (a rising hint line under "today's spend" looks like spend is
 * going up), and a wide title bar read as a broken chart frame. A spinner states
 * only "loading"; the reserved height keeps the card from jumping when the
 * chart arrives.
 */
import { tr } from '../../i18n.js';

interface ChartLoadingStateProps {
  /** Plot-area height in px; reserved so the layout never shifts. */
  height?: number;
}

export default function ChartLoadingState({ height = 280 }: ChartLoadingStateProps) {
  return (
    <div
      style={{
        minHeight: height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      data-chart-loading
      aria-busy="true"
    >
      <span className="spinner" role="status" aria-label={tr('加载中')} />
    </div>
  );
}
