import HoverPopover from './HoverPopover.js';
import { RouteIcon } from './MiniIcons.js';
import { tr } from '../i18n.js';

type ActualModelTriggerProps = {
  /** The model the client asked for (may be a group/alias name). */
  requestedModel: string;
  actualModel?: string | null;
  size?: number;
};

const rowLabelStyle = { fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 1 } as const;
const rowValueStyle = { fontSize: 11, wordBreak: 'break-all' } as const;

/**
 * The route glyph next to a model name in the usage log, shown only when the
 * request did not go upstream under the name it was asked for (a group route or
 * an alias resolved it). Hovering it floats the request/actual pair; tapping it
 * floats the same card on touch (`HoverPopover`, like the dashboard charts).
 *
 * Mirrors new-api's `model-badge.tsx` `<Route>` icon — the answer lives next to
 * the model in the list instead of inside the row's detail panel.
 */
export default function ActualModelTrigger({
  requestedModel,
  actualModel,
  size = 12,
}: ActualModelTriggerProps) {
  const actual = (actualModel || '').trim();
  const requested = (requestedModel || '').trim();
  if (!actual || actual === requested) return null;

  return (
    <HoverPopover
      testId="actual-model-popover"
      content={(
        <div style={{ display: 'grid', gap: 6, minWidth: 160 }}>
          <div>
            <div style={rowLabelStyle}>{tr('请求模型')}</div>
            <code style={rowValueStyle}>{requested || '-'}</code>
          </div>
          <div>
            <div style={rowLabelStyle}>{tr('实际模型')}</div>
            <code style={rowValueStyle}>{actual}</code>
          </div>
        </div>
      )}
    >
      <button
        type="button"
        aria-label={`${tr('实际模型')}：${actual}`}
        data-testid="actual-model-trigger"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          // A 12px glyph is a hard hover target: pad the hit area by 4px and pull
          // the box back so the icon keeps its position next to the badge.
          padding: 4,
          margin: -4,
          border: 'none',
          background: 'transparent',
          color: 'var(--color-text-muted)',
          cursor: 'pointer',
          flexShrink: 0,
          lineHeight: 1,
        }}
      >
        <RouteIcon size={size} />
      </button>
    </HoverPopover>
  );
}
