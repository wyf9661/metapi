import React, { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';
import { marked } from 'marked';
import katex from 'katex';
import ResponsiveFilterPanel from '../components/ResponsiveFilterPanel.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import PaginationControls from '../components/PaginationControls.js';
import CenteredModal from '../components/CenteredModal.js';
import MobileDrawer from '../components/MobileDrawer.js';
import { tr } from '../i18n.js';

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

type ProbeLogStats = {
  total: number;
  success: number;
  failed: number;
  timeout: number;
  avgLatencyMs: number;
  totalTokens: number;
};

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
        <div className="probe-detail-label">状态</div>
        <span className={STATUS_COLORS[log.status] || 'badge'}>{STATUS_LABELS[log.status] || log.status}</span>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">时间</div>
        <div className="probe-detail-value">{formatDateTimeLocal(log.createdAt)}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">模型</div>
        <div className="probe-detail-value">{log.modelName}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">分类</div>
        <div className="probe-detail-value">{CATEGORY_LABELS[log.questionCategory] || '-'}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">站点</div>
        <div className="probe-detail-value">{log.siteName || `#${log.siteId}`}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">账号</div>
        <div className="probe-detail-value">{log.accountUsername || `#${log.accountId}`}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">延迟</div>
        <div className="probe-detail-value">{formatLatency(log.latencyMs)}</div>
      </div>
      <div className="probe-detail-item">
        <div className="probe-detail-label">Token</div>
        <div className="probe-detail-value">{log.tokensUsed || '-'}</div>
      </div>

      {log.errorMessage ? (
        <div className="probe-detail-item probe-detail-wide">
          <div className="probe-detail-label">错误信息</div>
          <div className="probe-detail-error">{log.errorMessage}</div>
        </div>
      ) : null}

      <div className="probe-detail-item probe-detail-wide">
        <div className="probe-detail-label">问题</div>
        <div className="probe-detail-block">{log.questionText}</div>
      </div>

      {log.responseText ? (
        <div className="probe-detail-item probe-detail-wide">
          <div className="probe-detail-label">回答</div>
          <div className="probe-detail-block probe-detail-answer" dangerouslySetInnerHTML={{ __html: renderResponseText(log.responseText) }} />
        </div>
      ) : null}
    </div>
  );
}

export default function ProbeLogs() {
  const isMobile = useIsMobile();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [logs, setLogs] = useState<ProbeLog[]>([]);
  const [stats, setStats] = useState<ProbeLogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
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
  const pageSize = 50;

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (siteId) params.set('siteId', siteId);
      if (accountId) params.set('accountId', accountId);
      if (modelName) params.set('modelName', modelName);
      if (status) params.set('status', status);
      if (startTime) params.set('startTime', new Date(startTime).toISOString());
      if (endTime) params.set('endTime', new Date(endTime).toISOString());
      params.set('limit', pageSize.toString());
      params.set('offset', ((page - 1) * pageSize).toString());

      const data = await api.getProbeLogs(params.toString());
      setLogs(data.logs);
      setTotal(data.total);
    } catch (error) {
      toast.error('获取测活日志失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const params = new URLSearchParams();
      if (startTime) params.set('startTime', new Date(startTime).toISOString());
      if (endTime) params.set('endTime', new Date(endTime).toISOString());
      const data = await api.getProbeLogStats(params.toString());
      setStats(data);
    } catch (error) {
      console.error('获取统计失败', error);
    }
  };

  useEffect(() => {
    fetchLogs();
    fetchStats();
  }, [siteId, accountId, modelName, status, startTime, endTime, page]);

  const updateSearchParams = (key: string, value: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) {
      newParams.set(key, value);
    } else {
      newParams.delete(key);
    }
    setSearchParams(newParams);
  };

  const totalPages = Math.ceil(total / pageSize);

  const formatLatency = (ms: number | null) => {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  // LaTeX 公式占位符前缀，用于在 marked 渲染前后安全传递
  const KATEX_DISPLAY = '%%KATEX_DISPLAY_';
  const KATEX_INLINE = '%%KATEX_INLINE_';
  const KATEX_END = '%%';

  // 在 marked 渲染前后处理 LaTeX：预提取 → 渲染 Markdown → 替换为 KaTeX HTML
  const renderMarkdownWithLatex = (text: string): string => {
    const formulas: string[] = [];

    // 提取 LaTeX 公式并替换为占位符，防止被 marked 误解析
    // 匹配顺序重要：$$ 必须在 $ 之前，\[ 在 \( 之前
    const sanitized = text
      // 块级公式：$$ ... $$
      .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => {
        const idx = formulas.length;
        formulas.push(tex.trim());
        return KATEX_DISPLAY + idx + KATEX_END;
      })
      // 块级公式：\[ ... \]
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex) => {
        const idx = formulas.length;
        formulas.push(tex.trim());
        return KATEX_DISPLAY + idx + KATEX_END;
      })
      // 行内公式：$ ... $（不匹配 $$，不跨行，不匹配空内容）
      .replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_m, tex) => {
        const idx = formulas.length;
        formulas.push(tex.trim());
        return KATEX_INLINE + idx + KATEX_END;
      })
      // 行内公式：\( ... \)
      .replace(/\\\((.+?)\\\)/g, (_m, tex) => {
        const idx = formulas.length;
        formulas.push(tex.trim());
        return KATEX_INLINE + idx + KATEX_END;
      });

    // 用 marked 渲染 Markdown
    let html: string;
    try {
      html = String(marked.parse(sanitized, { gfm: true, breaks: true }));
    } catch {
      html = sanitized;
    }

    // 将占位符替换为 KaTeX 渲染后的 HTML
    if (formulas.length > 0) {
      // 块级公式：用 <div> 居中包裹
      html = html.replace(/%%KATEX_DISPLAY_(\d+)%%/g, (_m, idx) => {
        const tex = formulas[parseInt(idx)];
        try {
          return `<div class="katex-display-block">${katex.renderToString(tex, { displayMode: true, throwOnError: false, trust: true })}</div>`;
        } catch {
          return `<code class="katex-fallback">${tex}</code>`;
        }
      });
      // 行内公式
      html = html.replace(/%%KATEX_INLINE_(\d+)%%/g, (_m, idx) => {
        const tex = formulas[parseInt(idx)];
        try {
          return katex.renderToString(tex, { displayMode: false, throwOnError: false, trust: true });
        } catch {
          return `<code class="katex-fallback">${tex}</code>`;
        }
      });
    }

    return html;
  };

  // 清理乱码、解析 JSON 提取内容、渲染 Markdown
  const renderResponseText = (raw: string | null | undefined): string => {
    const text = String(raw || '').trim();
    if (!text) return '-';

    // 检测并过滤纯乱码（二进制数据被保存为 UTF-8 替换字符，通常 < 20 字节且包含大量不可打印字符）
    const nonPrintableRatio = text.replace(/[\x20-\x7E\t\n\r]/g, '').length / Math.max(text.length, 1);
    if (nonPrintableRatio > 0.3 || text.length < 20 && text.includes('�')) {
      return '<div class="text-xs text-gray-400 italic">上游返回了非文本数据（可能为二进制/压缩响应，已过滤乱码）</div>';
    }

    // 尝试解析 JSON（完整的 API 响应对象）
    try {
      const parsed = JSON.parse(text);
      // OpenAI / 标准聊天响应格式
      const content = parsed?.choices?.[0]?.message?.content
        || parsed?.choices?.[0]?.delta?.content
        || parsed?.message?.content
        || parsed?.output?.[0]?.content?.[0]?.text
        || parsed?.content
        || parsed?.text
        || parsed?.output
        || null;
      if (content !== null && content !== undefined) {
        const cleanContent = String(content);
        try {
          return renderMarkdownWithLatex(cleanContent);
        } catch {
          return cleanContent;
        }
      }
      // JSON 解析成功但没有提取到内容字段，说明可能是其他格式的响应，直接渲染为格式化 JSON
      return `<pre class="text-xs whitespace-pre-wrap break-all">${JSON.stringify(parsed, null, 2)}</pre>`;
    } catch {
      // 不是有效 JSON，当作普通文本处理
    }

    // 普通文本：Markdown 渲染，支持换行和基本格式
    try {
      return renderMarkdownWithLatex(text);
    } catch {
      return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h2 className="page-title">{tr('测活日志')}</h2>
          <p className="page-subtitle">记录每次模型可用性探测的结果与耗时。</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
            onClick={() => {
              fetchLogs();
              fetchStats();
            }}
          >
            刷新
          </button>
        </div>
      </div>

      {/* 统计卡片 */}
      {stats && (
        <div className="probe-stats-grid">
          <div className="probe-stat-card">
            <div className="probe-stat-label">总数</div>
            <div className="probe-stat-value">{stats.total}</div>
          </div>
          <div className="probe-stat-card">
            <div className="probe-stat-label">成功</div>
            <div className="probe-stat-value" style={{ color: 'var(--color-success)' }}>{stats.success}</div>
          </div>
          <div className="probe-stat-card">
            <div className="probe-stat-label">失败</div>
            <div className="probe-stat-value" style={{ color: 'var(--color-danger)' }}>{stats.failed}</div>
          </div>
          <div className="probe-stat-card">
            <div className="probe-stat-label">超时</div>
            <div className="probe-stat-value" style={{ color: 'var(--color-warning)' }}>{stats.timeout}</div>
          </div>
          <div className="probe-stat-card">
            <div className="probe-stat-label">平均延迟</div>
            <div className="probe-stat-value">{formatLatency(stats.avgLatencyMs)}</div>
          </div>
          <div className="probe-stat-card">
            <div className="probe-stat-label">总 Token</div>
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
            <input className="form-input" type="text" value={siteId} placeholder="站点 ID"
              onChange={(e) => { setSiteId(e.target.value); setPage(1); updateSearchParams('siteId', e.target.value); }} />
            <input className="form-input" type="text" value={accountId} placeholder="账号 ID"
              onChange={(e) => { setAccountId(e.target.value); setPage(1); updateSearchParams('accountId', e.target.value); }} />
            <input className="form-input" type="text" value={modelName} placeholder="模型名称"
              onChange={(e) => { setModelName(e.target.value); setPage(1); updateSearchParams('modelName', e.target.value); }} />
            <select className="form-input" value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1); updateSearchParams('status', e.target.value); }}>
              <option value="">全部状态</option>
              <option value="success">成功</option>
              <option value="failed">失败</option>
              <option value="timeout">超时</option>
            </select>
            <input className="form-input" type="datetime-local" value={startTime}
              onChange={(e) => { setStartTime(e.target.value); setPage(1); updateSearchParams('startTime', e.target.value); }} />
            <input className="form-input" type="datetime-local" value={endTime}
              onChange={(e) => { setEndTime(e.target.value); setPage(1); updateSearchParams('endTime', e.target.value); }} />
            <div className="probe-filter-total">共 {total} 条</div>
          </div>
        )}
        desktopContent={(
          <div className="card" style={{ padding: 14, marginBottom: 12 }}>
            <div className="probe-filter-grid">
              <input className="form-input" type="text" value={siteId} placeholder="站点 ID"
                onChange={(e) => { setSiteId(e.target.value); setPage(1); updateSearchParams('siteId', e.target.value); }} />
              <input className="form-input" type="text" value={accountId} placeholder="账号 ID"
                onChange={(e) => { setAccountId(e.target.value); setPage(1); updateSearchParams('accountId', e.target.value); }} />
              <input className="form-input" type="text" value={modelName} placeholder="模型名称"
                onChange={(e) => { setModelName(e.target.value); setPage(1); updateSearchParams('modelName', e.target.value); }} />
              <select className="form-input" value={status}
                onChange={(e) => { setStatus(e.target.value); setPage(1); updateSearchParams('status', e.target.value); }}>
                <option value="">全部状态</option>
                <option value="success">成功</option>
                <option value="failed">失败</option>
                <option value="timeout">超时</option>
              </select>
              <input className="form-input" type="datetime-local" value={startTime}
                onChange={(e) => { setStartTime(e.target.value); setPage(1); updateSearchParams('startTime', e.target.value); }} />
              <input className="form-input" type="datetime-local" value={endTime}
                onChange={(e) => { setEndTime(e.target.value); setPage(1); updateSearchParams('endTime', e.target.value); }} />
            </div>
            <div className="probe-filter-total">共 {total} 条</div>
          </div>
        )}
      />

      {/* 日志列表 */}
      <div className="card" style={{ overflowX: 'auto' }}>
        {loading ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" style={{ width: '100%', height: 34, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '100%', height: 34, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '100%', height: 34 }} />
          </div>
        ) : logs.length === 0 ? (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <div className="empty-state-title">暂无测活记录</div>
            <div className="empty-state-desc">当前筛选条件下没有测活日志。</div>
          </div>
        ) : (
          <>
            {isMobile ? (
              <div className="mobile-card-list">
                {logs.map((log) => (
                  <MobileCard
                    key={log.id}
                    title={log.modelName}
                    headerActions={<span className={`badge ${STATUS_COLORS[log.status]}`} style={{ fontSize: 11 }}>{STATUS_LABELS[log.status]}</span>}
                    footerActions={
                      <button type="button" className="btn btn-link btn-link-primary" onClick={() => setSelectedLog(log)}>查看详情</button>
                    }
                  >
                    <MobileField label="时间" value={formatDateTimeLocal(log.createdAt)} />
                    <MobileField label="站点/账号" value={`${log.siteName || `站点 #${log.siteId}`} · ${log.accountUsername || `账号 #${log.accountId}`}`} />
                    <MobileField label="分类" value={CATEGORY_LABELS[log.questionCategory] || '-'} />
                    <MobileField label="延迟" value={formatLatency(log.latencyMs)} />
                    <MobileField label="Token" value={log.tokensUsed || '-'} />
                    <MobileField label="问题" value={log.questionText} stacked />
                  </MobileCard>
                ))}
              </div>
            ) : (
              <table className="data-table probe-logs-table">
                <colgroup>
                  <col style={{ width: 90 }} />
                  <col style={{ width: 160 }} />
                  <col style={{ width: 180 }} />
                  <col />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 280 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>时间</th>
                    <th>模型</th>
                    <th>站点/账号</th>
                    <th>分类</th>
                    <th>延迟</th>
                    <th>Token</th>
                    <th>问题</th>
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
                        <span className={STATUS_COLORS[log.status]} style={{ fontSize: 11 }}>{STATUS_LABELS[log.status]}</span>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                        {formatDateTimeLocal(log.createdAt)}
                      </td>
                      <td style={{ fontWeight: 500 }}>
                        {log.modelName}
                      </td>
                      <td>
                        <div>{log.siteName || `站点 #${log.siteId}`}</div>
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{log.accountUsername || `账号 #${log.accountId}`}</div>
                      </td>
                      <td>
                        {CATEGORY_LABELS[log.questionCategory]}
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
              visible={totalPages > 1}
            />
          </>
        )}
      </div>

      {/* 详情弹窗：桌面端 portal 居中弹框，移动端右滑抽屉，避免被页面横向滚动影响 */}
      {selectedLog && (
        <>
          {isMobile ? (
            <MobileDrawer
              open={Boolean(selectedLog)}
              onClose={() => setSelectedLog(null)}
              title="测活详情"
              closeLabel="关闭测活详情"
              side="right"
            >
              <div className="probe-detail-body">
                <ProbeDetailFields log={selectedLog} formatLatency={formatLatency} STATUS_COLORS={STATUS_COLORS} STATUS_LABELS={STATUS_LABELS} CATEGORY_LABELS={CATEGORY_LABELS} formatDateTimeLocal={formatDateTimeLocal} renderResponseText={renderResponseText} />
              </div>
            </MobileDrawer>
          ) : (
            <CenteredModal
              open={Boolean(selectedLog)}
              onClose={() => setSelectedLog(null)}
              title="测活详情"
              maxWidth={900}
              closeOnBackdrop
              closeOnEscape
            >
              <ProbeDetailFields log={selectedLog} formatLatency={formatLatency} STATUS_COLORS={STATUS_COLORS} STATUS_LABELS={STATUS_LABELS} CATEGORY_LABELS={CATEGORY_LABELS} formatDateTimeLocal={formatDateTimeLocal} renderResponseText={renderResponseText} />
            </CenteredModal>
          )}
        </>
      )}
    </div>
  );
}
