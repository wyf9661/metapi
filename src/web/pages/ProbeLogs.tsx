import { useEffect, useState, useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';
import { PillTabBg } from '../components/PillTabBg.js';
import ResponsiveFilterPanel from '../components/ResponsiveFilterPanel.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import PaginationControls from '../components/PaginationControls.js';
import CenteredModal from '../components/CenteredModal.js';
import ListPage from '../components/ListPage.js';
import MobileDrawer from '../components/MobileDrawer.js';
import { tr, useI18n } from '../i18n.js';
import DateTimeInput from '../components/DateTimeInput.js';
import ModernSelect from '../components/ModernSelect.js';
import { usePersistedPageSize } from '../components/usePersistedPageSize.js';
import { StatusText } from '../components/StatusText.js';
import { renderProbeResponseText as renderResponseText } from './helpers/probeLogResponseRender.js';

type ProbeLog = {
  id: number;
  siteId: number;
  accountId: number;
  modelName: string;
  questionCategory: string;
  questionText: string;
  responseText: string | null;
  status: string;
  latencyMs: number | null;
  tokensUsed: number | null;
  errorMessage: string | null;
  createdAt: string;
  siteName?: string;
  accountUsername?: string;
};

const EMPTY_LOGS: ProbeLog[] = [];
const EMPTY_FILTER_OPTIONS = { sites: [], accounts: [], models: [] };

const CATEGORY_LABELS: Record<string, string> = {
  math: '数学',
  logic: '逻辑',
  knowledge: '知识',
  reasoning: '推理',
};

const STATUS_LABELS: Record<string, string> = {
  success: '成功',
  failed: '失败',
  timeout: '超时',
};

const STATUS_COLORS: Record<string, string> = {
  success: 'badge badge-success',
  failed: 'badge badge-error',
  timeout: 'badge badge-warning',
};

function ProbeDetailFields({
  log,
  formatLatency,
  STATUS_COLORS,
  STATUS_LABELS,
  CATEGORY_LABELS,
  formatDateTimeLocal,
  renderResponseText,
}: {
  log: ProbeLog;
  formatLatency: (ms: number | null) => string;
  STATUS_COLORS: Record<string, string>;
  STATUS_LABELS: Record<string, string>;
  CATEGORY_LABELS: Record<string, string>;
  formatDateTimeLocal: (value?: string | null) => string;
  renderResponseText: (raw: string | null | undefined) => string;
}) {
  return (
    <div className="probe-detail-grid">
      <div className="probe-detail-item">
        <div className="probe-detail-label">{tr('状态')}</div>
        <StatusText badgeClass={STATUS_COLORS[log.status] || 'badge'}>{STATUS_LABELS[log.status] || log.status}</StatusText>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">{tr('时间')}</div>
        <div className="probe-detail-value">{formatDateTimeLocal(log.createdAt)}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">{tr('模型')}</div>
        <div className="probe-detail-value">{log.modelName}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">{tr('分类')}</div>
        <div className="probe-detail-value">{CATEGORY_LABELS[log.questionCategory] || '-'}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">{tr('站点')}</div>
        <div className="probe-detail-value">{log.siteName || `#${log.siteId}`}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">{tr('账号')}</div>
        <div className="probe-detail-value">{log.accountUsername || `#${log.accountId}`}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">{tr('延迟')}</div>
        <div className="probe-detail-value">{formatLatency(log.latencyMs)}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">Token</div>
        <div className="probe-detail-value">{log.tokensUsed || '-'}</div>
      </div>

      {log.errorMessage ? (
        <div className="probe-detail-item probe-detail-wide">
          <div className="probe-detail-label">{tr('错误信息')}</div>
          <div className="probe-detail-error">{log.errorMessage}</div>
        </div>
      ) : null}

      <div className="probe-detail-item probe-detail-wide">
        <div className="probe-detail-label">{tr('问题')}</div>
        <div className="probe-detail-block">{log.questionText}</div>
      </div>

      {log.responseText ? (
        <div className="probe-detail-item probe-detail-wide">
          <div className="probe-detail-label">{tr('回答')}</div>
          <div className="probe-detail-block probe-detail-answer" dangerouslySetInnerHTML={{ __html: renderResponseText(log.responseText) }} />
        </div>
      ) : null}
    </div>
  );
}

export default function ProbeLogs() {
  const isMobile = useIsMobile();
  const toast = useToast();
  const { language } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedLog, setSelectedLog] = useState<ProbeLog | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  // 过滤条件
  const [siteId, setSiteId] = useState(searchParams.get('siteId') || '');
  const [accountId, setAccountId] = useState(searchParams.get('accountId') || '');
  const [modelName, setModelName] = useState(searchParams.get('modelName') || '');
  const [status, setStatus] = useState(searchParams.get('status') || '');
  const [startTime, setStartTime] = useState(searchParams.get('startTime') || '');
  const [endTime, setEndTime] = useState(searchParams.get('endTime') || '');

  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1'));
  const [pageSize, setPageSize] = usePersistedPageSize('probeLogs');
  // 筛选选项数据
  const { data: filterOptions = EMPTY_FILTER_OPTIONS } = useQuery({
    queryKey: ['probe-log-filters'],
    queryFn: () => api.getProbeLogFilters(),
    staleTime: Infinity,
  });

  const siteOptions = useMemo(() => {
    const opts = filterOptions.sites.map((s) => ({ value: String(s.id), label: s.name }));
    if (siteId && !opts.some((o) => o.value === siteId)) {
      opts.unshift({ value: siteId, label: `站点 #${siteId}` });
    }
    return [{ value: '', label: tr('全部站点') }, ...opts];
  }, [filterOptions.sites, siteId]);

  const accountOptions = useMemo(() => {
    const opts = filterOptions.accounts.map((a) => ({ value: String(a.id), label: a.username }));
    if (accountId && !opts.some((o) => o.value === accountId)) {
      opts.unshift({ value: accountId, label: `账号 #${accountId}` });
    }
    return [{ value: '', label: tr('全部账号') }, ...opts];
  }, [filterOptions.accounts, accountId]);

  const modelOptions = useMemo(() => {
    const opts = filterOptions.models.map((m) => ({ value: m, label: m }));
    if (modelName && !opts.some((o) => o.value === modelName)) {
      opts.unshift({ value: modelName, label: modelName });
    }
    return [{ value: '', label: tr('全部模型') }, ...opts];
  }, [filterOptions.models, modelName]);

  const logsParams = useMemo(() => {
    const params = new URLSearchParams();
    if (siteId) params.set('siteId', siteId);
    if (accountId) params.set('accountId', accountId);
    if (modelName) params.set('modelName', modelName);
    if (status) params.set('status', status);
    if (startTime) params.set('startTime', new Date(startTime).toISOString());
    if (endTime) params.set('endTime', new Date(endTime).toISOString());
    params.set('limit', pageSize.toString());
    params.set('offset', ((page - 1) * pageSize).toString());
    return params.toString();
  }, [siteId, accountId, modelName, status, startTime, endTime, page, pageSize]);

  const logsQuery = useQuery({
    queryKey: ['probe-logs', logsParams],
    queryFn: () => api.getProbeLogs(logsParams),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const statsParams = useMemo(() => {
    const params = new URLSearchParams();
    if (startTime) params.set('startTime', new Date(startTime).toISOString());
    if (endTime) params.set('endTime', new Date(endTime).toISOString());
    return params.toString();
  }, [startTime, endTime]);

  // Stats only depend on the time range — paging/site/status flips must not
  // re-fetch them.
  const statsQuery = useQuery({
    queryKey: ['probe-log-stats', statsParams],
    queryFn: () => api.getProbeLogStats(statsParams),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const logs = logsQuery.data?.logs ?? EMPTY_LOGS;
  const total = logsQuery.data?.total ?? 0;
  const stats = statsQuery.data ?? null;
  const loading = logsQuery.isFetching;

  useEffect(() => {
    if (logsQuery.isError) toast.error(tr('获取测活日志失败'));
  }, [logsQuery.isError, logsQuery.errorUpdatedAt]);

  const updateSearchParams = (key: string, value: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) {
      newParams.set(key, value);
    } else {
      newParams.delete(key);
    }
    setSearchParams(newParams);
  };

  const hasActiveFilters = Boolean(siteId || accountId || modelName || status || startTime || endTime || page !== 1);

  // 一次性清除所有筛选参数并回到第一页。
  const resetFilters = () => {
    if (!hasActiveFilters) return;
    setSiteId('');
    setAccountId('');
    setModelName('');
    setStatus('');
    setStartTime('');
    setEndTime('');
    setPage(1);
    setSearchParams(new URLSearchParams(), { replace: true });
    setShowFilters(false);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const formatLatency = (ms: number | null) => {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  // 时间格式跟随界面语言：中文用 zh-CN（YYYY/MM/DD HH:mm:ss），英文用 en（MM/DD/YYYY hh:mm:ss AM/PM）。
  // 避免中英文界面下时间格式不统一。
  const fmtDateTime = (value?: string | null) =>
    formatDateTimeLocal(value, language === 'zh' ? 'zh-CN' : 'en-US');

  return (
    <>
      <ListPage
        title={tr('测活日志')}
        subtitle={tr('记录每次模型可用性探测的结果与耗时。')}
        actions={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
            onClick={() => {
              logsQuery.refetch();
              statsQuery.refetch();
            }}
          >
            {tr('刷新')}
          </button>
        }
        loading={loading}
        isEmpty={logs.length === 0}
        emptyTitle={tr('暂无测活记录')}
        emptyDesc={tr('当前筛选条件下没有测活日志。')}
        beforeList={
          <>

      {/* 统计卡片 */}
      {stats && (
        <div className="probe-stats-grid">
          <div className="probe-stat-card">
            <div className="probe-stat-label">{tr('总数')}</div>
            <div className="probe-stat-value">{stats.total}</div>
          </div>
          <div className="probe-stat-card">
            <div className="probe-stat-label">{tr('成功')}</div>
            <div className="probe-stat-value" style={{ color: 'var(--color-success)' }}>{stats.success}</div>
          </div>
          <div className="probe-stat-card">
            <div className="probe-stat-label">{tr('失败')}</div>
            <div className="probe-stat-value" style={{ color: 'var(--color-danger)' }}>{stats.failed}</div>
          </div>
          <div className="probe-stat-card">
            <div className="probe-stat-label">{tr('超时')}</div>
            <div className="probe-stat-value" style={{ color: 'var(--color-warning)' }}>{stats.timeout}</div>
          </div>
          <div className="probe-stat-card">
            <div className="probe-stat-label">{tr('平均延迟')}</div>
            <div className="probe-stat-value">{formatLatency(stats.avgLatencyMs)}</div>
          </div>
          <div className="probe-stat-card">
            <div className="probe-stat-label">{tr('总 Token')}</div>
            <div className="probe-stat-value">{stats.totalTokens || 0}</div>
          </div>
        </div>
      )}

      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={showFilters}
        onMobileOpen={() => setShowFilters(true)}
        onMobileClose={() => setShowFilters(false)}
        mobileTitle="筛选测活日志"
        mobileContent={(
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div className="probe-filter-label" style={{ marginBottom: 6 }}>{tr('状态')}</div>
              <div className="pill-tabs">
                {[
                  { key: '', label: tr('全部') },
                  { key: 'success', label: tr('成功') },
                  { key: 'failed', label: tr('失败') },
                  { key: 'timeout', label: tr('超时') },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`pill-tab ${status === tab.key ? 'active' : ''}`}
                    onClick={() => { setStatus(tab.key); setPage(1); updateSearchParams('status', tab.key); }}
                  >
                    {status === tab.key && <PillTabBg />}
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
            <ModernSelect
              value={siteId}
              onChange={(v) => { setSiteId(v); setPage(1); updateSearchParams('siteId', v); }}
              options={siteOptions}
              placeholder={tr('站点')}
              size="sm"
              searchable
            />
            <ModernSelect
              value={accountId}
              onChange={(v) => { setAccountId(v); setPage(1); updateSearchParams('accountId', v); }}
              options={accountOptions}
              placeholder={tr('账号')}
              size="sm"
              searchable
            />
            <ModernSelect
              value={modelName}
              onChange={(v) => { setModelName(v); setPage(1); updateSearchParams('modelName', v); }}
              options={modelOptions}
              placeholder={tr('模型')}
              size="sm"
              searchable
            />
            <DateTimeInput
              value={startTime}
              max={endTime || undefined}
              onChange={(v) => { setStartTime(v); setPage(1); updateSearchParams('startTime', v); }}
              placeholder={tr('开始时间')}
              label={tr('开始')}
            />
            <DateTimeInput
              value={endTime}
              min={startTime || undefined}
              onChange={(v) => { setEndTime(v); setPage(1); updateSearchParams('endTime', v); }}
              placeholder={tr('结束时间')}
              label={tr('结束')}
            />
            <div className="probe-filter-total">共 {total} 条</div>
          </div>
        )}
        desktopContent={(
          <div className="toolbar probe-filter-toolbar" style={{ marginBottom: 12 }}>
            <div className="pill-tabs">
              {[
                { key: '', label: tr('全部') },
                { key: 'success', label: tr('成功') },
                { key: 'failed', label: tr('失败') },
                { key: 'timeout', label: tr('超时') },
              ].map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={`pill-tab ${status === tab.key ? 'active' : ''}`}
                  onClick={() => { setStatus(tab.key); setPage(1); updateSearchParams('status', tab.key); }}
                >
                  {status === tab.key && <PillTabBg />}
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="probe-filter-select">
              <span>{tr('站点 ID')}</span>
              <ModernSelect
                value={siteId}
                onChange={(v) => { setSiteId(v); setPage(1); updateSearchParams('siteId', v); }}
                options={siteOptions}
                placeholder={tr('全部站点')}
                size="sm"
                searchable
              />
            </div>
            <div className="probe-filter-select">
              <span>{tr('账号 ID')}</span>
              <ModernSelect
                value={accountId}
                onChange={(v) => { setAccountId(v); setPage(1); updateSearchParams('accountId', v); }}
                options={accountOptions}
                placeholder={tr('全部账号')}
                size="sm"
                searchable
              />
            </div>
            <div className="probe-filter-select">
              <span>{tr('模型名称')}</span>
              <ModernSelect
                value={modelName}
                onChange={(v) => { setModelName(v); setPage(1); updateSearchParams('modelName', v); }}
                options={modelOptions}
                placeholder={tr('全部模型')}
                size="sm"
                searchable
              />
            </div>
            <DateTimeInput
              value={startTime}
              max={endTime || undefined}
              onChange={(v) => { setStartTime(v); setPage(1); updateSearchParams('startTime', v); }}
              placeholder={tr('开始时间')}
              label={tr('开始')}
            />
            <DateTimeInput
              value={endTime}
              min={startTime || undefined}
              onChange={(v) => { setEndTime(v); setPage(1); updateSearchParams('endTime', v); }}
              placeholder={tr('结束时间')}
              label={tr('结束')}
            />
            <div style={{ marginLeft: 'auto' }}>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)', padding: '8px 12px' }}
                onClick={resetFilters}
                disabled={!hasActiveFilters}
                title={hasActiveFilters ? '清除全部筛选条件并回到第一页' : '当前没有筛选条件'}
              >{tr('清除筛选')}</button>
            </div>
          </div>
        )}
      />
          </>
        }
      >
      {isMobile ? (
              <div className="mobile-card-list">
                {logs.map((log) => (
                  <MobileCard
                    key={log.id}
                    title={log.modelName}
                    headerActions={<StatusText badgeClass={STATUS_COLORS[log.status]} style={{ fontSize: 11 }}>{STATUS_LABELS[log.status]}</StatusText>}
                    footerActions={
                      <button type="button" className="btn btn-link btn-link-primary" onClick={() => setSelectedLog(log)}>{tr('查看详情')}</button>
                    }
                  >
                    <MobileField label={tr('时间')} value={fmtDateTime(log.createdAt)} />
                    <MobileField label={tr('站点/账号')} value={`${log.siteName || `站点 #${log.siteId}`} · ${log.accountUsername || `账号 #${log.accountId}`}`} />
                    <MobileField label={tr('分类')} value={CATEGORY_LABELS[log.questionCategory] || '-'} />
                    <MobileField label={tr('延迟')} value={formatLatency(log.latencyMs)} />
                    <MobileField label="Token" value={log.tokensUsed || '-'} />
                    <MobileField label={tr('问题')} value={log.questionText} stacked />
                  </MobileCard>
                ))}
              </div>
            ) : (
                      <table className="data-table probe-logs-table">
                <colgroup>
                  <col style={{ width: 90 }} />
                  <col style={{ width: 160 }} />
                  <col style={{ width: 180 }} />
                  <col style={{ width: 130 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 350 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>{tr('状态')}</th>
                    <th>{tr('时间')}</th>
                    <th>{tr('模型')}</th>
                    <th>{tr('站点/账号')}</th>
                    <th>{tr('分类')}</th>
                    <th>{tr('延迟')}</th>
                    <th>Token</th>
                    <th>{tr('问题')}</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr
                      key={log.id}
                      className="row-selectable"
                      onClick={() => setSelectedLog(log)}
                    >
                      <td>
                        <StatusText badgeClass={STATUS_COLORS[log.status]} style={{ fontSize: 11 }}>{STATUS_LABELS[log.status]}</StatusText>
                      </td>
                      <td style={{ color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtDateTime(log.createdAt)}
                      </td>
                      <td style={{ fontWeight: 500 }}>
                        {log.modelName}
                      </td>
                      <td>
                        <div>{log.siteName || `站点 #${log.siteId}`}</div>
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{log.accountUsername || `账号 #${log.accountId}`}</div>
                      </td>
                      <td>
                        {CATEGORY_LABELS[log.questionCategory] || '-'}
                      </td>
                      <td>
                        {formatLatency(log.latencyMs)}
                      </td>
                      <td>
                        {log.tokensUsed || '-'}
                      </td>
                      <td className="probe-question-cell">
                        {log.questionText}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
      )}
      </ListPage>

      {total > 0 && (
        <PaginationControls
          page={page}
          totalPages={totalPages}
          onPageChange={(next) => {
            setPage((current) => {
              const resolved = typeof next === 'function' ? next(current) : next;
              const safe = Math.max(1, Math.min(totalPages, resolved));
              updateSearchParams('page', String(safe));
              return safe;
            });
          }}
          visible
          rangeLabel={`显示第 ${(page - 1) * pageSize + 1} - ${Math.min(page * pageSize, total)} 条，共 ${total} 条`}
          pageSize={pageSize}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
            updateSearchParams('page', '1');
          }}
        />
      )}

      {/* 详情弹窗：桌面端 portal 居中弹框，移动端右滑抽屉，避免被页面横向滚动影响 */}
      {selectedLog && (
        <>
          {isMobile ? (
            <MobileDrawer
              open={Boolean(selectedLog)}
              onClose={() => setSelectedLog(null)}
              title={tr('测活详情')}
              closeLabel="关闭测活详情"
              side="right"
            >
              <div className="probe-detail-body">
                <ProbeDetailFields log={selectedLog} formatLatency={formatLatency} STATUS_COLORS={STATUS_COLORS} STATUS_LABELS={STATUS_LABELS} CATEGORY_LABELS={CATEGORY_LABELS} formatDateTimeLocal={fmtDateTime} renderResponseText={renderResponseText} />
              </div>
            </MobileDrawer>
          ) : (
            <CenteredModal
              open={Boolean(selectedLog)}
              onClose={() => setSelectedLog(null)}
              title={tr('测活详情')}
              maxWidth={900}
              closeOnBackdrop
              closeOnEscape
            >
              <ProbeDetailFields log={selectedLog} formatLatency={formatLatency} STATUS_COLORS={STATUS_COLORS} STATUS_LABELS={STATUS_LABELS} CATEGORY_LABELS={CATEGORY_LABELS} formatDateTimeLocal={fmtDateTime} renderResponseText={renderResponseText} />
            </CenteredModal>
          )}
        </>
      )}
    </>
  );
}
