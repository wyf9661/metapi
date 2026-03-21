import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';

type BackupType = 'all' | 'accounts' | 'preferences';

type ParsedSummary = {
  valid: boolean;
  version: string;
  timestampLabel: string;
  hasAccounts: boolean;
  hasPreferences: boolean;
  hasLegacyData: boolean;
  isAllApiHubV2: boolean;
  sitesCount: number;
  accountsCount: number;
  bookmarksCount: number;
  profilesCount: number;
  tokensCount: number;
  routesCount: number;
  channelsCount: number;
  settingsCount: number;
  ignoredSections: string[];
};

type WebdavConfigForm = {
  enabled: boolean;
  fileUrl: string;
  username: string;
  password: string;
  exportType: BackupType;
  autoSyncEnabled: boolean;
  autoSyncCron: string;
  hasPassword: boolean;
  passwordMasked: string;
};

type WebdavSyncState = {
  lastSyncAt: string | null;
  lastError: string | null;
};

type WebdavConfigSnapshot = {
  enabled: boolean;
  fileUrl: string;
  username: string;
  exportType: BackupType;
  autoSyncEnabled: boolean;
  autoSyncCron: string;
  hasPassword: boolean;
};

const DEFAULT_WEBDAV_CONFIG: WebdavConfigForm = {
  enabled: false,
  fileUrl: '',
  username: '',
  password: '',
  exportType: 'all',
  autoSyncEnabled: false,
  autoSyncCron: '0 */6 * * *',
  hasPassword: false,
  passwordMasked: '',
};

const DEFAULT_WEBDAV_SNAPSHOT: WebdavConfigSnapshot = {
  enabled: false,
  fileUrl: '',
  username: '',
  exportType: 'all',
  autoSyncEnabled: false,
  autoSyncCron: '0 */6 * * *',
  hasPassword: false,
};

function downloadJsonFile(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function parseImportSummary(raw: string): ParsedSummary | null {
  if (!raw.trim()) return null;

  const invalidSummary = (): ParsedSummary => ({
    valid: false,
    version: '-',
    timestampLabel: '未知',
    hasAccounts: false,
    hasPreferences: false,
    hasLegacyData: false,
    isAllApiHubV2: false,
    sitesCount: 0,
    accountsCount: 0,
    bookmarksCount: 0,
    profilesCount: 0,
    tokensCount: 0,
    routesCount: 0,
    channelsCount: 0,
    settingsCount: 0,
    ignoredSections: [],
  });

  try {
    const data = JSON.parse(raw) as any;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return invalidSummary();
    }

    const accountsSection = (data.accounts && typeof data.accounts === 'object' && !Array.isArray(data.accounts))
      ? data.accounts
      : null;
    const preferencesSection = (data.preferences && typeof data.preferences === 'object' && !Array.isArray(data.preferences))
      ? data.preferences
      : null;

    const legacyAccounts = Boolean(data.data?.accounts || Array.isArray(data.accounts));
    const legacyPrefs = Boolean(data.data?.preferences);
    const profilesCount = Array.isArray(data.apiCredentialProfiles?.profiles) ? data.apiCredentialProfiles.profiles.length : 0;
    const bookmarksCount = Array.isArray(accountsSection?.bookmarks) ? accountsSection.bookmarks.length : 0;
    const isNativeMetapiBackup = Boolean(
      accountsSection
      && Array.isArray(accountsSection.sites)
      && Array.isArray(accountsSection.accountTokens)
      && Array.isArray(accountsSection.tokenRoutes)
      && Array.isArray(accountsSection.routeChannels)
    );
    const hasLegacyAccountRows = Array.isArray(accountsSection?.accounts)
      && accountsSection.accounts.some((row: any) => row && typeof row === 'object' && !Array.isArray(row) && (
        'site_url' in row
        || 'site_type' in row
        || 'account_info' in row
        || 'cookieAuth' in row
        || 'authType' in row
        || 'sub2apiAuth' in row
      ));
    const isAllApiHubV2 = Boolean(
      accountsSection
      && !isNativeMetapiBackup
      && hasLegacyAccountRows
      && Array.isArray(accountsSection.accounts)
      && (
        (typeof data.version === 'string' && data.version.startsWith('2'))
        || 'last_updated' in accountsSection
        || Array.isArray(accountsSection.bookmarks)
        || Array.isArray(accountsSection.pinnedAccountIds)
        || Array.isArray(accountsSection.orderedAccountIds)
        || profilesCount > 0
      )
    );

    const hasAccounts = Boolean(
      data.type === 'accounts'
      || accountsSection
      || legacyAccounts,
    );
    const hasPreferences = Boolean(
      data.type === 'preferences'
      || preferencesSection
      || legacyPrefs,
    );
    const ignoredSections: string[] = [];
    if (bookmarksCount > 0) ignoredSections.push('accounts.bookmarks');
    if (data.channelConfigs && typeof data.channelConfigs === 'object' && !Array.isArray(data.channelConfigs)) ignoredSections.push('channelConfigs');
    if (data.tagStore && typeof data.tagStore === 'object' && !Array.isArray(data.tagStore)) ignoredSections.push('tagStore');

    const toCount = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

    const ts = data.timestamp !== undefined && data.timestamp !== null
      ? new Date(data.timestamp)
      : null;
    const timestampLabel = ts && !Number.isNaN(ts.getTime()) ? ts.toLocaleString() : '未知';

    return {
      valid: hasAccounts || hasPreferences,
      version: typeof data.version === 'string' ? data.version : '1.0',
      timestampLabel,
      hasAccounts,
      hasPreferences,
      hasLegacyData: legacyAccounts || legacyPrefs,
      isAllApiHubV2,
      sitesCount: toCount(accountsSection?.sites),
      accountsCount: toCount(accountsSection?.accounts),
      bookmarksCount,
      profilesCount,
      tokensCount: toCount(accountsSection?.accountTokens),
      routesCount: toCount(accountsSection?.tokenRoutes),
      channelsCount: toCount(accountsSection?.routeChannels),
      settingsCount: toCount(preferencesSection?.settings),
      ignoredSections,
    };
  } catch {
    return invalidSummary();
  }
}

function buildImportSuccessMessage(result: any): string {
  const sections: string[] = [];
  if (result?.sections?.accounts) sections.push('账号与路由');
  if (result?.sections?.preferences) sections.push('系统设置');

  const parts = [`导入完成：${sections.length ? sections.join('、') : '无有效数据'}`];
  if (result?.summary) {
    const summary = result.summary;
    parts.push(
      [
        `站点 ${summary.importedSites ?? 0}`,
        `账号 ${summary.importedAccounts ?? 0}`,
        `API Key 连接 ${summary.importedApiKeyConnections ?? summary.importedProfiles ?? 0}`,
        `跳过 ${summary.skippedAccounts ?? 0}`,
      ].join(' / '),
    );

    if (Array.isArray(summary.ignoredSections) && summary.ignoredSections.length > 0) {
      parts.push(`未原生导入 ${summary.ignoredSections.join('、')}`);
    }
  }

  if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
    const preview = result.warnings.slice(0, 2).join('；');
    parts.push(`提示：${preview}${result.warnings.length > 2 ? ` 等 ${result.warnings.length} 项` : ''}`);
  }

  return parts.join('；');
}

export default function ImportExport() {
  const toast = useToast();
  const [exportingType, setExportingType] = useState<BackupType | ''>('');
  const [importing, setImporting] = useState(false);
  const [importData, setImportData] = useState('');
  const [selectedFileName, setSelectedFileName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [webdavConfig, setWebdavConfig] = useState<WebdavConfigForm>(DEFAULT_WEBDAV_CONFIG);
  const [savedWebdavConfig, setSavedWebdavConfig] = useState<WebdavConfigSnapshot>(DEFAULT_WEBDAV_SNAPSHOT);
  const [webdavState, setWebdavState] = useState<WebdavSyncState>({ lastSyncAt: null, lastError: null });
  const [webdavSaving, setWebdavSaving] = useState(false);
  const [webdavAction, setWebdavAction] = useState<'export' | 'import' | ''>('');
  const [clearWebdavPassword, setClearWebdavPassword] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const summary = useMemo(() => parseImportSummary(importData), [importData]);

  const buildWebdavForm = (config: any): WebdavConfigForm => ({
    enabled: config.enabled === true,
    fileUrl: String(config.fileUrl || ''),
    username: String(config.username || ''),
    password: '',
    exportType: config.exportType === 'accounts' || config.exportType === 'preferences' ? config.exportType : 'all',
    autoSyncEnabled: config.autoSyncEnabled === true,
    autoSyncCron: String(config.autoSyncCron || DEFAULT_WEBDAV_CONFIG.autoSyncCron),
    hasPassword: config.hasPassword === true,
    passwordMasked: String(config.passwordMasked || ''),
  });

  const buildWebdavSnapshot = (config: any): WebdavConfigSnapshot => ({
    enabled: config.enabled === true,
    fileUrl: String(config.fileUrl || ''),
    username: String(config.username || ''),
    exportType: config.exportType === 'accounts' || config.exportType === 'preferences' ? config.exportType : 'all',
    autoSyncEnabled: config.autoSyncEnabled === true,
    autoSyncCron: String(config.autoSyncCron || DEFAULT_WEBDAV_CONFIG.autoSyncCron),
    hasPassword: config.hasPassword === true,
  });

  const applyWebdavResponse = (result: any) => {
    const config = result?.config;
    if (config) {
      setWebdavConfig(buildWebdavForm(config));
      setSavedWebdavConfig(buildWebdavSnapshot(config));
      setClearWebdavPassword(false);
    }
    const state = result?.state || result;
    setWebdavState((prev) => ({
      lastSyncAt: typeof state?.lastSyncAt === 'string' ? state.lastSyncAt : prev.lastSyncAt,
      lastError: typeof state?.lastError === 'string'
        ? state.lastError
        : (state?.lastError === null ? null : prev.lastError),
    }));
  };

  const webdavConfigDirty = (
    webdavConfig.enabled !== savedWebdavConfig.enabled
    || webdavConfig.fileUrl !== savedWebdavConfig.fileUrl
    || webdavConfig.username !== savedWebdavConfig.username
    || webdavConfig.exportType !== savedWebdavConfig.exportType
    || webdavConfig.autoSyncEnabled !== savedWebdavConfig.autoSyncEnabled
    || webdavConfig.autoSyncCron !== savedWebdavConfig.autoSyncCron
    || webdavConfig.hasPassword !== savedWebdavConfig.hasPassword
    || webdavConfig.password.trim().length > 0
    || clearWebdavPassword
  );

  useEffect(() => {
    let alive = true;
    void api.getBackupWebdavConfig()
      .then((result: any) => {
        if (!alive) return;
        applyWebdavResponse(result);
      })
      .catch((err: any) => {
        if (!alive) return;
        toast.error(err?.message || '加载 WebDAV 配置失败');
      });
    return () => {
      alive = false;
    };
  }, [toast]);

  const handleExport = async (type: BackupType) => {
    setExportingType(type);
    try {
      const data = await api.exportBackup(type);
      const date = new Date().toISOString().split('T')[0];
      const fileName: Record<BackupType, string> = {
        all: `metapi-backup-${date}.json`,
        accounts: `metapi-accounts-${date}.json`,
        preferences: `metapi-preferences-${date}.json`,
      };
      downloadJsonFile(data, fileName[type]);
      toast.success('导出成功');
    } catch (err: any) {
      toast.error(err?.message || '导出失败');
    } finally {
      setExportingType('');
    }
  };

  const readFile = (file: File) => {
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      toast.error('请选择 JSON 格式的备份文件');
      return;
    }
    setSelectedFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      setImportData(String(e.target?.result || ''));
    };
    reader.onerror = () => toast.error('读取文件失败');
    reader.readAsText(file);
  };

  const handleImportFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    readFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleImport = async () => {
    if (!importData.trim()) {
      toast.error('请先选择或粘贴 JSON 备份内容');
      return;
    }
    if (!summary?.valid) {
      toast.error('当前 JSON 结构无法识别');
      return;
    }
    const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function'
      ? true
      : window.confirm('导入会覆盖账号/路由或系统设置，确认继续？');
    if (!confirmed) {
      return;
    }

    setImporting(true);
    try {
      const parsed = JSON.parse(importData);
      const result = await api.importBackup(parsed);
      toast.success(buildImportSuccessMessage(result));
      setImportData('');
      setSelectedFileName('');
    } catch (err: any) {
      toast.error(err?.message || '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const handleSaveWebdavConfig = async () => {
    setWebdavSaving(true);
    try {
      const nextPassword = webdavConfig.password.trim();
      const payload: Record<string, unknown> = {
        enabled: webdavConfig.enabled,
        fileUrl: webdavConfig.fileUrl,
        username: webdavConfig.username,
        exportType: webdavConfig.exportType,
        autoSyncEnabled: webdavConfig.autoSyncEnabled,
        autoSyncCron: webdavConfig.autoSyncCron,
      };
      if (nextPassword) {
        payload.password = webdavConfig.password;
      } else if (clearWebdavPassword) {
        payload.clearPassword = true;
      }
      const result = await api.saveBackupWebdavConfig(payload as any);
      applyWebdavResponse(result);
      toast.success('WebDAV 配置已保存');
    } catch (err: any) {
      toast.error(err?.message || '保存 WebDAV 配置失败');
    } finally {
      setWebdavSaving(false);
    }
  };

  const handleExportToWebdav = async () => {
    setWebdavAction('export');
    try {
      const result = await api.exportBackupToWebdav(webdavConfig.exportType);
      applyWebdavResponse(result);
      toast.success(`已导出到 WebDAV：${result?.fileUrl || webdavConfig.fileUrl}`);
    } catch (err: any) {
      toast.error(err?.message || '导出到 WebDAV 失败');
    } finally {
      setWebdavAction('');
    }
  };

  const handleImportFromWebdav = async () => {
    const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function'
      ? true
      : window.confirm('从 WebDAV 导入会覆盖本地账号/路由或系统设置，确认继续？');
    if (!confirmed) return;
    setWebdavAction('import');
    try {
      const result = await api.importBackupFromWebdav();
      applyWebdavResponse(result);
      toast.success(buildImportSuccessMessage(result));
    } catch (err: any) {
      toast.error(err?.message || '从 WebDAV 导入失败');
    } finally {
      setWebdavAction('');
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="page-header" style={{ alignItems: 'flex-end', marginBottom: 18 }}>
        <div>
          <h2 className="page-title" style={{ marginBottom: 6 }}>{tr('导入 / 导出')}</h2>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            支持全量备份、分区备份与手动恢复。
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="badge badge-muted" style={{ fontSize: 11 }}>Schema v2.0</span>
          <span className="badge badge-warning" style={{ fontSize: 11 }}>敏感数据请离线保管</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))', gap: 14 }}>
        {/* ====== 导出区 ====== */}
        <div className="card animate-slide-up stagger-1" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="var(--color-primary)">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <span style={{ fontSize: 15, fontWeight: 700 }}>导出数据</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 14 }}>
            将数据导出为 JSON 文件进行备份
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <button
              onClick={() => handleExport('all')}
              disabled={!!exportingType}
              className="btn btn-primary"
              style={{ justifyContent: 'space-between' }}
            >
              <span>导出全部（账号 + 路由 + 设置）</span>
              {exportingType === 'all' ? <span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> : null}
            </button>
            <button
              onClick={() => handleExport('accounts')}
              disabled={!!exportingType}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)', justifyContent: 'space-between' }}
            >
              <span>仅导出账号与路由</span>
              {exportingType === 'accounts' ? <span className="spinner spinner-sm" /> : null}
            </button>
            <button
              onClick={() => handleExport('preferences')}
              disabled={!!exportingType}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)', justifyContent: 'space-between' }}
            >
              <span>仅导出系统设置</span>
              {exportingType === 'preferences' ? <span className="spinner spinner-sm" /> : null}
            </button>
          </div>
        </div>

        {/* ====== 导入区 ====== */}
        <div className="card animate-slide-up stagger-2" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="var(--color-primary)">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span style={{ fontSize: 15, fontWeight: 700 }}>导入数据</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 14 }}>
            从备份文件恢复数据
          </div>

          <div style={{ display: 'grid', gap: 12 }}>
            {/* ---- 拖拽上传区 ---- */}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? 'var(--color-primary)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-md)',
                padding: '28px 20px',
                textAlign: 'center',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                background: dragOver ? 'var(--color-primary-light)' : 'var(--color-bg)',
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleImportFile}
                style={{ display: 'none' }}
              />
              {selectedFileName ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="var(--color-success)">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    {selectedFileName}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    点击重新选择文件
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  <svg width="36" height="36" fill="none" viewBox="0 0 24 24" stroke={dragOver ? 'var(--color-primary)' : 'var(--color-text-muted)'} style={{ transition: 'stroke 0.2s' }}>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <div style={{ fontSize: 13, fontWeight: 600, color: dragOver ? 'var(--color-primary)' : 'var(--color-text-secondary)' }}>
                    {dragOver ? '松开以导入文件' : '拖拽 JSON 备份文件到此处'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    或 <span style={{ color: 'var(--color-primary)', fontWeight: 500 }}>点击选择文件</span>
                  </div>
                </div>
              )}
            </div>

            {/* ---- 数据预览 ---- */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>数据预览</div>
              <textarea
                value={importData}
                onChange={(e) => setImportData(e.target.value)}
                placeholder="粘贴 JSON 数据或通过上面的拖拽区域导入..."
                style={{
                  width: '100%',
                  minHeight: 100,
                  resize: 'vertical',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  padding: '10px 12px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-bg)',
                  color: 'var(--color-text-primary)',
                }}
              />
            </div>

            {/* ---- 解析摘要 ---- */}
            {summary ? (
              <div
                style={{
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${summary.valid
                    ? 'color-mix(in srgb, var(--color-success) 35%, transparent)'
                    : 'color-mix(in srgb, var(--color-danger) 35%, transparent)'}`,
                  background: summary.valid
                    ? 'color-mix(in srgb, var(--color-success) 10%, transparent)'
                    : 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
                  color: summary.valid ? 'var(--color-success)' : 'var(--color-danger)',
                  padding: '10px 12px',
                  fontSize: 12,
                  lineHeight: 1.6,
                }}
              >
                {summary.valid ? (
                  <>
                    <div>结构有效，版本：{summary.version}，时间：{summary.timestampLabel}</div>
                    <div>包含分区：{summary.hasAccounts ? '账号路由' : ''}{summary.hasAccounts && summary.hasPreferences ? ' + ' : ''}{summary.hasPreferences ? '系统设置' : ''}</div>
                    {summary.isAllApiHubV2 ? (
                      <>
                        <div>检测到 ALL-API-Hub V2 兼容备份：将离线迁移可用连接。</div>
                        <div>
                          统计：账号 {summary.accountsCount} / 书签 {summary.bookmarksCount} / 独立 API 凭据 {summary.profilesCount}
                        </div>
                        {summary.ignoredSections.length ? (
                          <div>不会原生导入：{summary.ignoredSections.join('、')}</div>
                        ) : null}
                      </>
                    ) : null}
                    {(summary.sitesCount || summary.accountsCount || summary.tokensCount || summary.routesCount || summary.channelsCount || summary.settingsCount) ? (
                      <div>
                        统计：站点 {summary.sitesCount} / 账号 {summary.accountsCount} / 令牌 {summary.tokensCount} / 路由 {summary.routesCount} / 通道 {summary.channelsCount} / 设置 {summary.settingsCount}
                      </div>
                    ) : null}
                    {summary.hasLegacyData ? <div>检测到兼容结构：将按兼容模式导入。</div> : null}
                  </>
                ) : (
                  <div>JSON 可解析，但结构不受支持。</div>
                )}
              </div>
            ) : null}

            {/* ---- 操作按钮 ---- */}
            <button
              onClick={handleImport}
              disabled={importing || !summary?.valid}
              className="btn btn-primary"
              style={{ width: '100%', padding: '10px 0', fontSize: 14, fontWeight: 600, borderRadius: 'var(--radius-sm)' }}
            >
              {importing ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 导入中...</> : '导入'}
            </button>
          </div>
        </div>
      </div>

      <div className="card animate-slide-up stagger-3" style={{ marginTop: 14, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="var(--color-primary)">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999A5.002 5.002 0 006 9a4 4 0 00-3 6z" />
          </svg>
          <span style={{ fontSize: 15, fontWeight: 700 }}>WebDAV 同步</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 14 }}>
          支持手动推送、手动拉取，以及定时自动导出到 WebDAV。
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>文件 URL</span>
            <input
              value={webdavConfig.fileUrl}
              onChange={(e) => setWebdavConfig((prev) => ({ ...prev, fileUrl: e.target.value }))}
              placeholder="https://dav.example.com/backups/metapi.json"
              style={{ width: '100%' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>用户名</span>
            <input
              value={webdavConfig.username}
              onChange={(e) => setWebdavConfig((prev) => ({ ...prev, username: e.target.value }))}
              placeholder="可留空"
              style={{ width: '100%' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>密码</span>
            <input
              type="password"
              value={webdavConfig.password}
              onChange={(e) => {
                const nextPassword = e.target.value;
                setWebdavConfig((prev) => ({ ...prev, password: nextPassword }));
                if (nextPassword.trim()) {
                  setClearWebdavPassword(false);
                }
              }}
              placeholder={clearWebdavPassword
                ? '保存后将清空已存密码'
                : (webdavConfig.hasPassword ? `已保存 ${webdavConfig.passwordMasked}，留空则保持不变` : '请输入密码')}
              disabled={clearWebdavPassword}
              style={{ width: '100%' }}
            />
            {webdavConfig.hasPassword ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={clearWebdavPassword}
                  onChange={(e) => {
                    const checked = e.target.checked === true;
                    setClearWebdavPassword(checked);
                    if (checked) {
                      setWebdavConfig((prev) => ({ ...prev, password: '' }));
                    }
                  }}
                />
                清空已保存密码
              </label>
            ) : null}
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>导出分区</span>
            <select
              value={webdavConfig.exportType}
              onChange={(e) => setWebdavConfig((prev) => ({ ...prev, exportType: e.target.value as BackupType }))}
            >
              <option value="all">全部</option>
              <option value="accounts">账号与路由</option>
              <option value="preferences">系统设置</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>自动同步 Cron</span>
            <input
              value={webdavConfig.autoSyncCron}
              onChange={(e) => setWebdavConfig((prev) => ({ ...prev, autoSyncCron: e.target.value }))}
              placeholder="0 */6 * * *"
              style={{ width: '100%' }}
            />
          </label>
          <div style={{ display: 'grid', gap: 8, alignContent: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={webdavConfig.enabled}
                onChange={(e) => setWebdavConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
              />
              启用 WebDAV
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={webdavConfig.autoSyncEnabled}
                onChange={(e) => setWebdavConfig((prev) => ({ ...prev, autoSyncEnabled: e.target.checked }))}
              />
              自动同步
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          <button
            onClick={handleSaveWebdavConfig}
            disabled={webdavSaving}
            className="btn btn-primary"
          >
            {webdavSaving ? '保存中...' : '保存 WebDAV 配置'}
          </button>
          <button
            onClick={handleExportToWebdav}
            disabled={webdavAction !== '' || webdavSaving || webdavConfigDirty}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
          >
            {webdavAction === 'export' ? '导出中...' : '立即导出到 WebDAV'}
          </button>
          <button
            onClick={handleImportFromWebdav}
            disabled={webdavAction !== '' || webdavSaving || webdavConfigDirty}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
          >
            {webdavAction === 'import' ? '拉取中...' : '从 WebDAV 拉取'}
          </button>
        </div>

        {webdavConfigDirty ? (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-warning)' }}>
            当前 WebDAV 配置有未保存改动，请先保存后再执行导入或导出。
          </div>
        ) : null}

        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
          <div>上次同步：{webdavState.lastSyncAt ? new Date(webdavState.lastSyncAt).toLocaleString() : '尚未同步'}</div>
          <div>最近错误：{webdavState.lastError || '无'}</div>
        </div>
      </div>

      <div className="card animate-slide-up stagger-4" style={{ marginTop: 14, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>注意事项</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.75 }}>
          <div>1. 导入账号分区会覆盖现有站点、账号、令牌和路由配置。</div>
          <div>2. 为避免锁死管理界面，管理员登录令牌（`auth_token`）不会从备份导入。</div>
          <div>3. 建议先导出一份"全部备份"再执行导入操作。</div>
        </div>
      </div>
    </div>
  );
}
