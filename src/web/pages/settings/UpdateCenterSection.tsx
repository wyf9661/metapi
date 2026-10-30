import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { tr } from '../../i18n.js';
import { buildUpdateReminder } from '../helpers/updateCenterPresentation.js';

type UpdateVersionCandidate = {
  normalizedVersion?: string;
  displayVersion?: string;
  tagName?: string;
  digest?: string | null;
  publishedAt?: string | null;
} | null;

type UpdateCenterStatus = {
  currentVersion?: string;
  githubRelease?: UpdateVersionCandidate;
  dockerHubTag?: UpdateVersionCandidate;
  dockerHubRecentTags?: Array<NonNullable<UpdateVersionCandidate>> | null;
  runtime?: {
    lastCheckedAt?: string | null;
    lastCheckError?: string | null;
    lastResolvedDisplayVersion?: string | null;
  } | null;
};

type OtaStatusPayload = {
  supported?: boolean;
  supportedReason?: string;
  mode?: string;
  host?: {
    writableAppRoot?: boolean;
    graphicalSession?: boolean;
    pkexecAvailable?: boolean;
    supervised?: boolean;
    tier?: string;
  } | null;
  state?: {
    phase?: string;
    message?: string;
    version?: string;
    progressPct?: number;
    error?: string;
    command?: string;
  } | null;
  applied?: {
    status?: string;
    version?: string;
    fromVersion?: string;
  } | null;
  rollbackAvailable?: boolean;
};

function formatCheckedAt(value?: string | null): string {
  if (!value) return tr('从未检查');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return tr('从未检查');
  return parsed.toLocaleString();
}

function renderCandidateVersion(candidate: UpdateVersionCandidate | null | undefined): string {
  if (!candidate) return '—';
  return candidate.displayVersion || candidate.normalizedVersion || candidate.tagName || '—';
}

export default function UpdateCenterSection() {
  const toast = useToast();
  const [status, setStatus] = useState<UpdateCenterStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [ota, setOta] = useState<OtaStatusPayload | null>(null);
  const [otaBusy, setOtaBusy] = useState(false);
  const otaPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.getUpdateCenterStatus() as UpdateCenterStatus;
      setStatus(next);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(errorMessage || tr('获取更新中心状态失败'));
    }
    try {
      const otaNext = await api.getUpdateCenterOta() as OtaStatusPayload;
      setOta(otaNext);
    } catch {
      setOta(null);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    try {
      const next = await api.checkUpdateCenter() as UpdateCenterStatus;
      setStatus(next);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(errorMessage || tr('检查更新失败'));
    } finally {
      setChecking(false);
    }
  }, [toast]);

  useEffect(() => () => {
    if (otaPollTimer.current) clearInterval(otaPollTimer.current);
  }, []);

  const refreshOta = useCallback(async () => {
    try {
      const otaNext = await api.getUpdateCenterOta() as OtaStatusPayload;
      setOta(otaNext);
      const phase = otaNext?.state?.phase;
      if (phase !== 'downloading' && phase !== 'verifying' && phase !== 'applying' && phase !== 'restarting') {
        if (otaPollTimer.current) {
          clearInterval(otaPollTimer.current);
          otaPollTimer.current = null;
        }
        setOtaBusy(false);
      }
      return otaNext;
    } catch {
      return null;
    }
  }, []);

  const startOtaPolling = useCallback(() => {
    if (otaPollTimer.current) return;
    otaPollTimer.current = setInterval(() => {
      void refreshOta();
    }, 2000);
  }, [refreshOta]);

  const handleOtaApply = useCallback(async (version: string) => {
    setOtaBusy(true);
    try {
      await api.applyUpdateCenterOta(version);
      toast.success(`已开始在线更新到 v${version}`);
      startOtaPolling();
      await refreshOta();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(errorMessage || tr('在线更新启动失败'));
      setOtaBusy(false);
    }
  }, [refreshOta, startOtaPolling, toast]);

  const handleOtaRollback = useCallback(async () => {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function'
      && !window.confirm('确认回滚到更新前版本？更新后一天内有效，回滚会重启服务。')) return;
    setOtaBusy(true);
    try {
      await api.rollbackUpdateCenterOta();
      toast.success(tr('已发起回滚'));
      startOtaPolling();
      await refreshOta();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(errorMessage || tr('回滚失败'));
      setOtaBusy(false);
    }
  }, [refreshOta, startOtaPolling, toast]);

  const otaTargetVersion = String(
    status?.githubRelease?.normalizedVersion || status?.dockerHubTag?.normalizedVersion || '',
  ).trim();

  const reminder = buildUpdateReminder({
    currentVersion: status?.currentVersion,
    helper: null,
    githubRelease: status?.githubRelease,
    dockerHubTag: status?.dockerHubTag,
  });

  const canApplyOnline = Boolean(ota?.supported && reminder.highlight && otaTargetVersion);
  const otaProgressPct = typeof ota?.state?.progressPct === 'number' && ota.state.progressPct > 0
    ? Math.round(ota.state.progressPct)
    : 0;

  const rows: Array<{ label: string; value: string }> = [
    { label: tr('当前版本'), value: status?.currentVersion || '—' },
    { label: 'GitHub Releases', value: renderCandidateVersion(status?.githubRelease) },
    { label: 'Docker Hub', value: renderCandidateVersion(status?.dockerHubTag) },
    { label: tr('上次检查'), value: formatCheckedAt(status?.runtime?.lastCheckedAt) },
  ];

  return (
    <div className="card" style={{ padding: 14, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{tr('更新中心')}</div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {ota?.rollbackAvailable && (
            <button
              className="btn btn-sm"
              disabled={otaBusy}
              onClick={() => void handleOtaRollback()}
              style={{ border: '1px solid color-mix(in srgb, var(--color-warning) 45%, transparent)', color: 'var(--color-warning)', background: 'color-mix(in srgb, var(--color-warning) 12%, var(--color-bg-card))' }}
            >
              {tr('回滚到更新前版本')}
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            disabled={checking || otaBusy}
            onClick={() => {
              if (otaBusy) return;
              if (canApplyOnline) void handleOtaApply(otaTargetVersion);
              else void handleCheck();
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {canApplyOnline || otaBusy ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.92 }} aria-hidden="true">
                <path d="M12 3v12" />
                <path d="M8 11l4 4 4-4" />
                <path d="M5 21h14" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
            )}
            {otaBusy
              ? (otaProgressPct > 0 ? `${tr('在线更新中')} ${otaProgressPct}%` : tr('在线更新中...'))
              : canApplyOnline
                ? `更新到 v${otaTargetVersion}`
                : checking ? tr('检查中...') : tr('检查更新')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <span className={reminder.badgeClassName}>{reminder.label}</span>
      </div>
      {reminder.detail && (
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          {reminder.detail}
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((row) => (
          <div
            key={row.label}
            style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}
          >
            <span style={{ color: 'var(--color-text-muted)' }}>{row.label}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.value}</span>
          </div>
        ))}
      </div>

      {ota?.supported && ota.mode === 'host' && ota.host && (
        <div style={{ fontSize: 12, marginTop: 8, color: 'var(--color-text-muted)' }}>
          {ota.host.tier === 'direct'
            ? tr('宿主机模式：应用目录可写，更新零提权')
            : ota.host.tier === 'pkexec'
              ? tr('宿主机模式：需要提权时将弹出系统授权窗（polkit）')
              : tr('宿主机模式：无图形会话，需要提权时给出终端命令')}
        </div>
      )}
      {ota?.supported && ota.state && ota.state.phase && ota.state.phase !== 'idle' && (
        <div style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6, color: ota.state.phase === 'failed' ? 'var(--color-danger)' : 'var(--color-text-secondary)' }}>
          {ota.state.message || ota.state.phase}
          {typeof ota.state.progressPct === 'number' && ota.state.progressPct > 0 ? `（${ota.state.progressPct}%）` : ''}
          {ota.state.error ? `：${ota.state.error}` : ''}
          {ota.state.command && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 4, wordBreak: 'break-all', color: 'var(--color-text-primary)' }}>
              {ota.state.command}
            </div>
          )}
        </div>
      )}
      {ota?.applied && (
        <div style={{ fontSize: 12, marginTop: 8, color: 'var(--color-text-muted)' }}>
          {`在线更新记录：v${ota.applied.fromVersion} → v${ota.applied.version}（${ota.applied.status}）`}
        </div>
      )}

      {status?.runtime?.lastCheckError && (
        <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 10 }}>
          {tr('上次检查出错')}: {status.runtime.lastCheckError}
        </div>
      )}
    </div>
  );
}
