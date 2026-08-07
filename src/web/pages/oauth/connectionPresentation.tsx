/**
 * Presentation helpers and small display components for the OAuth management
 * page. Extracted from OAuthManagement.tsx (which was ~2.5k lines) — pure
 * move, zero behavior change. Everything here is derived from an
 * OAuthConnectionInfo/OAuthQuotaInfo and renders or formats a label.
 */
import {
  useEffect,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedVisibility } from '../../components/useAnimatedVisibility.js';
import type {
  OAuthConnectionInfo,
  OAuthQuotaInfo,
  OAuthQuotaWindowInfo,
  OAuthRouteParticipation,
  OAuthRouteUnitStrategy,
} from '../../api.js';

function asTrimmedString(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOauthMessage(value: string | null | undefined): string {
  const text = asTrimmedString(value);
  if (!text) return '';

  return text
    .replace(/codex usage windows inferred from rate limit response headers/ig, '额度窗口已从响应头推断')
    .replace(/official 5h quota window is not exposed by current codex oauth artifacts/ig, '当前 Codex OAuth 未暴露官方 5h 窗口')
    .replace(/official 7d quota window is not exposed by current codex oauth artifacts/ig, '当前 Codex OAuth 未暴露官方 7d 窗口')
    .replace(/official 5h quota window is unavailable for this provider/ig, '当前 Provider 不提供官方 5h 窗口')
    .replace(/official 7d quota window is unavailable for this provider/ig, '当前 Provider 不提供官方 7d 窗口')
    .replace(/\bfetch failed\b/ig, '网络请求失败');
}

export function resolveConnectionPrimaryTitle(connection: OAuthConnectionInfo): string {
  return asTrimmedString(connection.username)
    || asTrimmedString(connection.email)
    || asTrimmedString(connection.accountKey)
    || asTrimmedString(connection.provider)
    || 'OAuth 连接';
}

export function resolveConnectionEmailLabel(connection: OAuthConnectionInfo): string {
  return asTrimmedString(connection.email);
}

export function resolveConnectionStatusLabel(status?: string): string {
  return status === 'abnormal' ? '异常' : '正常';
}

export function resolveQuotaStatusLabel(status?: OAuthQuotaInfo['status']): string {
  if (status === 'unsupported') return '不支持';
  if (status === 'error') return '获取失败';
  return '支持';
}

export function resolveQuotaSourceLabel(source?: OAuthQuotaInfo['source']): string {
  return source === 'official' ? '官方' : '响应头推断';
}

export function resolveModelSyncStatusText(connection: OAuthConnectionInfo): string {
  const failureText = normalizeOauthMessage(connection.lastModelSyncError || '');
  if (failureText) return '获取失败';
  return connection.lastModelSyncAt ? '同步正常' : '未同步';
}

export function resolveQuotaSyncStatusText(quota?: OAuthQuotaInfo | null): string {
  if (!quota) return '未刷新额度';
  if (quota.status === 'error') {
    return '获取失败';
  }
  if (quota.status === 'unsupported') {
    return '不支持';
  }
  return quota.lastSyncAt ? '同步正常' : '未刷新';
}

export function resolveModelSyncDetail(connection: OAuthConnectionInfo): string {
  return normalizeOauthMessage(connection.lastModelSyncError || '');
}

export function resolveQuotaSyncDetail(quota?: OAuthQuotaInfo | null): string {
  if (!quota) return '';
  if (quota.status === 'error') {
    return normalizeOauthMessage(quota.lastError || quota.providerMessage || '额度刷新失败');
  }
  if (quota.status === 'unsupported') {
    return normalizeOauthMessage(quota.providerMessage || '当前连接暂不支持额度窗口');
  }
  return '';
}

function redactProxyUrl(value: string | null | undefined): string {
  const text = asTrimmedString(value);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '';
    }
    const serialized = parsed.toString();
    return parsed.pathname === '/' && !parsed.search && !parsed.hash
      ? serialized.replace(/\/$/, '')
      : serialized;
  } catch {
    return text.replace(/\/\/[^/@:\s]+(?::[^/@\s]*)?@/, '//***@');
  }
}

export function compactAccountKey(value?: string | null): string {
  const text = asTrimmedString(value || '');
  if (!text || text.length <= 24) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

export function formatResetLabel(value?: string | null): string {
  const text = asTrimmedString(value || '');
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return '现在';
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (diffHours >= 24) {
    const days = Math.floor(diffHours / 24);
    return `${days}d ${diffHours % 24}h`;
  }
  if (diffHours > 0) return `${diffHours}h ${diffMinutes}m`;
  return `${Math.max(1, diffMinutes)}m`;
}

export function resolveQuotaWindowPercent(window?: OAuthQuotaWindowInfo | null): number | null {
  if (!window?.supported) return null;
  if (typeof window.used === 'number' && typeof window.limit === 'number' && window.limit > 0) {
    return Math.max(0, Math.min(100, Math.round((window.used / window.limit) * 100)));
  }
  if (typeof window.remaining === 'number' && typeof window.limit === 'number' && window.limit > 0) {
    return Math.max(0, Math.min(100, Math.round(((window.limit - window.remaining) / window.limit) * 100)));
  }
  return null;
}

export function resolveQuotaWindowSummary(window?: OAuthQuotaWindowInfo | null): string {
  if (!window || !window.supported) return '';
  if (typeof window.used === 'number' && typeof window.limit === 'number') {
    return `${window.used} / ${window.limit}`;
  }
  if (typeof window.remaining === 'number' && typeof window.limit === 'number') {
    return `剩余 ${window.remaining} / ${window.limit}`;
  }
  if (typeof window.limit === 'number') return `总量 ${window.limit}`;
  return window.message || '官方未提供';
}

export function resolveProxyProjectSummary(connection: OAuthConnectionInfo): string {
  const parts = [
    asTrimmedString(connection.planType || ''),
    connection.projectId ? `Project ${connection.projectId}` : '',
  ].filter(Boolean);
  return parts.join(' · ') || '--';
}

export function resolveProxyDisplayText(connection: OAuthConnectionInfo): string {
  if (connection.proxyUrl) return redactProxyUrl(connection.proxyUrl);
  return '未设置代理';
}

export function hasOauthProxySelection(connection: OAuthConnectionInfo): boolean {
  return !!asTrimmedString(connection.proxyUrl);
}

export function resolveRouteUnitStrategyLabel(strategy?: OAuthRouteUnitStrategy | null): string {
  return strategy === 'stick_until_unavailable' ? '单个用到不可用再切' : '轮询';
}

export function resolveConnectionRouteParticipation(
  connection: OAuthConnectionInfo,
): OAuthRouteParticipation {
  if (connection.routeParticipation?.kind === 'route_unit') {
    return {
      ...connection.routeParticipation,
      id: connection.routeParticipation.id ?? connection.routeUnit?.id,
      routeUnitId: connection.routeParticipation.routeUnitId
        ?? connection.routeParticipation.id
        ?? connection.routeUnit?.routeUnitId
        ?? connection.routeUnit?.id,
    };
  }
  if (connection.routeParticipation?.kind === 'single') {
    return connection.routeParticipation;
  }
  if (connection.routeUnit) {
    return {
      kind: 'route_unit',
      routeUnitId: connection.routeUnit.routeUnitId ?? connection.routeUnit.id,
      id: connection.routeUnit.id,
      name: connection.routeUnit.name,
      strategy: connection.routeUnit.strategy,
      memberCount: connection.routeUnit.memberCount,
    };
  }
  return { kind: 'single' };
}

export function resolveRouteParticipationSummary(connection: OAuthConnectionInfo): string {
  const participation = resolveConnectionRouteParticipation(connection);
  if (participation.kind !== 'route_unit') {
    return '单体';
  }
  return `路由池：${participation.name} · ${participation.memberCount} 个成员 · ${resolveRouteUnitStrategyLabel(participation.strategy)}`;
}

export function renderCodeBlock(value: string) {
  return (
    <code className="oauth-code-block">{value}</code>
  );
}

export function renderGuideCard(title: string, description: string, children?: ReactNode) {
  return (
    <div className="oauth-guide-card">
      <div>
        <div className="oauth-guide-title">{title}</div>
        <div className="oauth-guide-copy">{description}</div>
      </div>
      {children}
    </div>
  );
}

export function QuotaWindowRow({
  label,
  window,
}: {
  label: string;
  window?: OAuthQuotaWindowInfo | null;
}) {
  const percent = resolveQuotaWindowPercent(window);
  const summary = resolveQuotaWindowSummary(window);
  const tone = percent != null && percent >= 90
    ? 'var(--color-danger)'
    : percent != null && percent >= 70
      ? 'var(--color-warning)'
      : 'var(--color-primary)';

  return (
    <div className="oauth-window-row">
      <div className="oauth-window-row-header">
        <span className="oauth-window-pill">{label}</span>
        <div className="oauth-window-meter">
          <div
            className="oauth-window-meter-fill"
            style={{
              width: `${percent ?? 0}%`,
              background: percent == null ? 'var(--color-border)' : tone,
            }}
          />
        </div>
        <span className="oauth-window-value">{percent == null ? 'N/A' : `${percent}%`}</span>
        {summary && percent == null ? <span className="oauth-window-summary">{summary}</span> : null}
        {window?.resetAt ? (
          <span className="oauth-window-reset">重置 {formatResetLabel(window.resetAt)}</span>
        ) : null}
      </div>
    </div>
  );
}

export function SideDrawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  const presence = useAnimatedVisibility(open, 220);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!presence.shouldRender) return null;

  const panel = (
    <div
      className={`modal-backdrop oauth-drawer-backdrop ${presence.isVisible ? '' : 'is-closing'}`.trim()}
      onClick={onClose}
    >
      <div
        className={`modal-content oauth-drawer-content ${presence.isVisible ? '' : 'is-closing'}`.trim()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header oauth-drawer-header">
          <div className="modal-title">{title}</div>
          <button
            type="button"
            className="modal-close-button oauth-drawer-close"
            onClick={onClose}
            aria-label="关闭 OAuth 抽屉"
          >
            ×
          </button>
        </div>
        <div className="modal-body oauth-drawer-body">
          {children}
        </div>
      </div>
    </div>
  );

  // Skip the portal under the test runner (react-test-renderer cannot host a
  // ReactDOM.createPortal into jsdom's document.body). Mirrors CenteredModal.
  const isTestEnv = import.meta.env.MODE === 'test';
  const portalTarget = !isTestEnv && typeof document !== 'undefined' ? document.body : null;
  return portalTarget ? createPortal(panel, portalTarget) : panel;
}
