import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { formatDateTimeMinuteLocal } from '../pages/helpers/checkinLogTime.js';
import { buildEventNavigationPath } from '../pages/helpers/navigationFocus.js';
import { useI18n } from '../i18n.js';
import { useAnimatedVisibility } from './useAnimatedVisibility.js';

const levelColors: Record<string, string> = {
  info: 'var(--color-info)',
  warning: 'var(--color-warning)',
  error: 'var(--color-danger)',
};

const typeLabels: Record<string, string> = {
  checkin: '签到',
  balance: '余额',
  token: '令牌',
  proxy: '代理',
  status: '状态',
  site_notice: '站点公告',
};

export default function NotificationPanel({
  open,
  onClose,
  anchorRef,
  onUnreadCountChange,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onUnreadCountChange?: (count: number) => void;
}) {
  const { t: tr } = useI18n();
  const presence = useAnimatedVisibility(open, 160);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>('');
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = filter ? `type=${filter}` : '';
      const data = await api.getEvents(params);
      setEvents(data);

      // Auto mark all as read on open
      const hasUnread = Array.isArray(data) && data.some((e: any) => !e.read);
      if (hasUnread) {
        api.markAllEventsRead().catch(() => {});
        onUnreadCountChange?.(0);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [filter, onUnreadCountChange]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose, anchorRef]);

  const clearAll = async () => {
    await api.clearEvents();
    setEvents([]);
    onUnreadCountChange?.(0);
  };

  if (!presence.shouldRender) return null;

  return (
    <div
      ref={panelRef}
      className={`user-dropdown ${presence.isVisible ? '' : 'is-closing'}`.trim()}
      style={{ right: 0, top: '100%', width: 360, maxHeight: 480, padding: 0, marginTop: 4 }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--color-border-light)' }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{tr('通知')}</span>
        <button onClick={clearAll} className="btn btn-link">
          {tr('清空')}
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: '1px solid var(--color-border-light)', flexWrap: 'wrap' }}>
        {['', 'checkin', 'balance', 'token', 'proxy', 'status', 'site_notice'].map((filterType) => (
          <button key={filterType} onClick={() => setFilter(filterType)}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 12,
              border: filter === filterType ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
              background: filter === filterType ? 'var(--color-primary-light)' : 'transparent',
              color: filter === filterType ? 'var(--color-primary)' : 'var(--color-text-muted)',
              cursor: 'pointer',
            }}>
            {filterType ? tr(typeLabels[filterType] || filterType) : tr('全部')}
          </button>
        ))}
      </div>

      {/* Events list */}
      <div style={{ maxHeight: 360, overflow: 'auto' }}>
        {loading && <div style={{ padding: 20, textAlign: 'center' }}><span className="spinner spinner-sm" /></div>}
        {!loading && events.length === 0 && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
            {tr('暂无通知')}
          </div>
        )}
        {events.map((ev: any) => {
          const targetPath = buildEventNavigationPath(ev);
          const openTarget = () => {
            onClose();
            navigate(targetPath);
          };
          return (
            <div
              key={ev.id}
              className="notification-event-item"
              style={{
                padding: '10px 16px',
                borderBottom: '1px solid var(--color-border-light)',
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                cursor: 'pointer',
              }}
              onClick={openTarget}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openTarget();
                }
              }}
            >
              <div style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 5,
                background: levelColors[ev.level] || 'var(--color-info)',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontWeight: 500, fontSize: 13 }}>{ev.title}</span>
                  <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 8, background: 'var(--color-bg)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border-light)' }}>
                    {tr(typeLabels[ev.type] || ev.type)}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>{ev.message}</div>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                  {formatDateTimeMinuteLocal(ev.createdAt)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
