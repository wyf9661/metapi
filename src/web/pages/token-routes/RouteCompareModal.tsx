import { useEffect, useMemo, useState } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import ModernSelect from '../../components/ModernSelect.js';
import { api } from '../../api.js';
import { tr } from '../../i18n.js';
import type { RouteChannel, RouteSummaryRow } from './types.js';

export type RouteChannelDiffKind = 'both' | 'changed' | 'left' | 'right';

export type RouteChannelDiffRow = {
  key: string;
  kind: RouteChannelDiffKind;
  left?: RouteChannel;
  right?: RouteChannel;
};

export function buildRouteChannelKey(channel: RouteChannel): string {
  const sourceModel = (channel.sourceModel || '').trim().toLowerCase();
  return `${channel.accountId}:${channel.tokenId ?? 'account'}::${sourceModel}`;
}

function sameChannelConfig(left: RouteChannel, right: RouteChannel): boolean {
  return left.priority === right.priority
    && left.weight === right.weight
    && left.enabled === right.enabled
    && left.manualOverride === right.manualOverride;
}

/**
 * Channel-level diff between two routes.
 *
 * Only the fields an operator can change per channel are compared; counters
 * (success/fail/last-used) always differ and would drown the real differences.
 */
export function diffRouteChannels(
  left: RouteChannel[],
  right: RouteChannel[],
): RouteChannelDiffRow[] {
  const leftByKey = new Map(left.map((channel) => [buildRouteChannelKey(channel), channel]));
  const rightByKey = new Map(right.map((channel) => [buildRouteChannelKey(channel), channel]));
  const rows: RouteChannelDiffRow[] = [];

  for (const [key, channel] of leftByKey) {
    const counterpart = rightByKey.get(key);
    if (!counterpart) {
      rows.push({ key, kind: 'left', left: channel });
      continue;
    }
    rows.push({
      key,
      kind: sameChannelConfig(channel, counterpart) ? 'both' : 'changed',
      left: channel,
      right: counterpart,
    });
  }
  for (const [key, channel] of rightByKey) {
    if (!leftByKey.has(key)) rows.push({ key, kind: 'right', right: channel });
  }

  const order: Record<RouteChannelDiffKind, number> = { changed: 0, left: 1, right: 2, both: 3 };
  return rows.sort((a, b) => order[a.kind] - order[b.kind]);
}

function channelLabel(channel: RouteChannel | undefined): string {
  if (!channel) return '—';
  const site = channel.site?.name || `#${channel.site?.id ?? '?'}`;
  const account = channel.account?.username || `#${channel.accountId}`;
  const token = channel.token?.name ? ` / ${channel.token.name}` : '';
  return `${site} · ${account}${token}`;
}

function compareCell(honour: string | number | boolean | null | undefined, other: string | number | boolean | null | undefined): boolean {
  return String(honour) !== String(other);
}

export default function RouteCompareModal({
  open,
  onClose,
  routes,
}: {
  open: boolean;
  onClose: () => void;
  routes: RouteSummaryRow[];
}) {
  const [leftId, setLeftId] = useState<number | null>(null);
  const [rightId, setRightId] = useState<number | null>(null);
  const [leftChannels, setLeftChannels] = useState<RouteChannel[]>([]);
  const [rightChannels, setRightChannels] = useState<RouteChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => routes.map((route) => ({
    value: String(route.id),
    label: `${route.displayName || route.modelPattern} (#${route.id})`,
  })), [routes]);

  useEffect(() => {
    if (!open || leftId === null || rightId === null) {
      setLeftChannels([]);
      setRightChannels([]);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.getRouteChannels(leftId), api.getRouteChannels(rightId)])
      .then(([left, right]) => {
        if (cancelled) return;
        setLeftChannels((left || []) as RouteChannel[]);
        setRightChannels((right || []) as RouteChannel[]);
      })
      .catch(() => {
        if (!cancelled) setError(tr('加载通道失败'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, leftId, rightId]);

  const rows = useMemo(
    () => diffRouteChannels(leftChannels, rightChannels),
    [leftChannels, rightChannels],
  );
  const leftRoute = routes.find((route) => route.id === leftId) || null;
  const rightRoute = routes.find((route) => route.id === rightId) || null;

  const summary = useMemo(() => {
    const count = (kind: RouteChannelDiffKind) => rows.filter((row) => row.kind === kind).length;
    return {
      left: count('left'),
      right: count('right'),
      changed: count('changed'),
      common: count('both'),
    };
  }, [rows]);

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={tr('路由比对')}
      maxWidth={980}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      footer={<button type="button" className="btn btn-ghost" onClick={onClose}>{tr('关闭')}</button>}
    >
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 260 }}>
          <div className="text-muted" style={{ fontSize: 12, marginBottom: 6 }}>{tr('路由 A')}</div>
          <ModernSelect
            value={leftId === null ? '' : String(leftId)}
            onChange={(value) => setLeftId(Number(value))}
            options={options}
            placeholder={tr('选择路由 A')}
            searchable
            searchPlaceholder={tr('搜索路由')}
          />
        </div>
        <div style={{ flex: '1 1 320px', minWidth: 260 }}>
          <div className="text-muted" style={{ fontSize: 12, marginBottom: 6 }}>{tr('路由 B')}</div>
          <ModernSelect
            value={rightId === null ? '' : String(rightId)}
            onChange={(value) => setRightId(Number(value))}
            options={options}
            placeholder={tr('选择路由 B')}
            searchable
            searchPlaceholder={tr('搜索路由')}
          />
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ margin: 0 }}>{error}</div>}

      {!leftRoute || !rightRoute ? (
        <div className="empty-state" style={{ padding: 28 }}>
          <div className="empty-state-desc">{tr('选择两条路由查看通道差异')}</div>
        </div>
      ) : (
        <>
          <div className="text-muted" style={{ fontSize: 12 }}>
            {tr('通道差异')}：{tr('仅 A')} {summary.left} · {tr('仅 B')} {summary.right} · {tr('配置不同')} {summary.changed} · {tr('相同')} {summary.common}
          </div>
          {loading ? (
            <div className="empty-state" style={{ padding: 24 }}>
              <span className="spinner spinner-sm" /> {tr('加载中...')}
            </div>
          ) : (
            <div style={{ overflow: 'auto', maxHeight: 420 }}>
              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: 74 }}>{tr('状态')}</th>
                    <th>{tr('站点 · 账号')}</th>
                    <th>{tr('源模型')}</th>
                    <th style={{ width: 76 }}>{tr('优先级')}</th>
                    <th style={{ width: 68 }}>{tr('权重')}</th>
                    <th style={{ width: 68 }}>{tr('启用')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const channel = row.left || row.right;
                    const kindLabel = row.kind === 'left'
                      ? tr('仅 A')
                      : row.kind === 'right'
                        ? tr('仅 B')
                        : row.kind === 'changed'
                          ? tr('配置不同')
                          : tr('相同');
                    return (
                      <tr key={row.key}>
                        <td>{kindLabel}</td>
                        <td>{channelLabel(channel)}</td>
                        <td>{(channel?.sourceModel || '').trim() || '—'}</td>
                        <td>{row.kind === 'changed' && compareCell(row.left?.priority, row.right?.priority)
                          ? `${row.left?.priority} → ${row.right?.priority}`
                          : channel?.priority}</td>
                        <td>{row.kind === 'changed' && compareCell(row.left?.weight, row.right?.weight)
                          ? `${row.left?.weight} → ${row.right?.weight}`
                          : channel?.weight}</td>
                        <td>{String(channel?.enabled ?? '')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </CenteredModal>
  );
}
