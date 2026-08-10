import { useCallback, useEffect, useState } from 'react';

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

  const load = useCallback(async () => {
    try {
      const next = await api.getUpdateCenterStatus() as UpdateCenterStatus;
      setStatus(next);
    } catch (error: any) {
      toast.error(error?.message || tr('获取更新中心状态失败'));
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
    } catch (error: any) {
      toast.error(error?.message || tr('检查更新失败'));
    } finally {
      setChecking(false);
    }
  }, [toast]);

  const reminder = buildUpdateReminder({
    currentVersion: status?.currentVersion,
    helper: null,
    githubRelease: status?.githubRelease,
    dockerHubTag: status?.dockerHubTag,
  });

  const rows: Array<{ label: string; value: string }> = [
    { label: tr('当前版本'), value: status?.currentVersion || '—' },
    { label: 'GitHub Releases', value: renderCandidateVersion(status?.githubRelease) },
    { label: 'Docker Hub', value: renderCandidateVersion(status?.dockerHubTag) },
    { label: tr('上次检查'), value: formatCheckedAt(status?.runtime?.lastCheckedAt) },
  ];

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{tr('更新中心')}</div>
        <button
          className="btn btn-primary btn-sm"
          disabled={checking}
          onClick={() => void handleCheck()}
        >
          {checking ? tr('检查中...') : tr('检查更新')}
        </button>
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

      {status?.runtime?.lastCheckError && (
        <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 10 }}>
          {tr('上次检查出错')}: {status.runtime.lastCheckError}
        </div>
      )}
    </div>
  );
}
