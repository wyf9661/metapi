import React, { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';
import { marked } from 'marked';

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
  success: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  timeout: 'bg-yellow-100 text-yellow-800',
};

export default function ProbeLogs() {
  const isMobile = useIsMobile();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [logs, setLogs] = useState<ProbeLog[]>([]);
  const [stats, setStats] = useState<ProbeLogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [selectedLog, setSelectedLog] = useState<ProbeLog | null>(null);

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

  // 清理乱码、解析 JSON 提取内容、�染 Markdown
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
          return String(marked.parse(cleanContent, { gfm: true, breaks: true }));
        } catch {
          return cleanContent;
        }
      }
      // JSON 解析成功但没有提取到内容字段，说明可能是其他格式的响应，直接渲染为格式化 JSON
      return `<pre class="text-xs whitespace-pre-wrap break-all">${JSON.stringify(parsed, null, 2)}</pre>`;
    } catch {
      // 不是有效 JSON，当作普通文本处理
    }

    // 普通文本：Markdown �染，支持换行和基本格式
    try {
      return String(marked.parse(text, { gfm: true, breaks: true }));
    } catch {
      return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  };

  return (
    <div className="container mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold mb-6">测活日志</h1>

      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-gray-500 text-sm">总数</div>
            <div className="text-2xl font-bold">{stats.total}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-gray-500 text-sm">成功</div>
            <div className="text-2xl font-bold text-green-600">{stats.success}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-gray-500 text-sm">失败</div>
            <div className="text-2xl font-bold text-red-600">{stats.failed}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-gray-500 text-sm">超时</div>
            <div className="text-2xl font-bold text-yellow-600">{stats.timeout}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-gray-500 text-sm">平均延迟</div>
            <div className="text-2xl font-bold">{formatLatency(stats.avgLatencyMs)}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-gray-500 text-sm">总 Token</div>
            <div className="text-2xl font-bold">{stats.totalTokens || 0}</div>
          </div>
        </div>
      )}

      {/* 过滤器 */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">站点</label>
            <input
              type="text"
              value={siteId}
              onChange={(e) => {
                setSiteId(e.target.value);
                setPage(1);
                updateSearchParams('siteId', e.target.value);
              }}
              placeholder="站点 ID"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">账号</label>
            <input
              type="text"
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                setPage(1);
                updateSearchParams('accountId', e.target.value);
              }}
              placeholder="账号 ID"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">模型</label>
            <input
              type="text"
              value={modelName}
              onChange={(e) => {
                setModelName(e.target.value);
                setPage(1);
                updateSearchParams('modelName', e.target.value);
              }}
              placeholder="模型名称"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
                updateSearchParams('status', e.target.value);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">全部</option>
              <option value="success">成功</option>
              <option value="failed">失败</option>
              <option value="timeout">超时</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">开始时间</label>
            <input
              type="datetime-local"
              value={startTime}
              onChange={(e) => {
                setStartTime(e.target.value);
                setPage(1);
                updateSearchParams('startTime', e.target.value);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">结束时间</label>
            <input
              type="datetime-local"
              value={endTime}
              onChange={(e) => {
                setEndTime(e.target.value);
                setPage(1);
                updateSearchParams('endTime', e.target.value);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {/* 日志列表 */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">加载中...</div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-gray-500">暂无数据</div>
        ) : (
          <>
            {isMobile ? (
              // 移动端卡片视图
              <div className="divide-y divide-gray-200">
                {logs.map((log) => (
                  <div
                    key={log.id}
                    className="p-4 hover:bg-gray-50 cursor-pointer"
                    onClick={() => setSelectedLog(log)}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${STATUS_COLORS[log.status]}`}>
                        {STATUS_LABELS[log.status]}
                      </span>
                      <span className="text-xs text-gray-500">
                        {formatDateTimeLocal(log.createdAt)}
                      </span>
                    </div>
                    <div className="text-sm font-medium mb-1">{log.modelName}</div>
                    <div className="text-xs text-gray-600">
                      {log.siteName || `站点 #${log.siteId}`} · {log.accountUsername || `账号 #${log.accountId}`}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {CATEGORY_LABELS[log.questionCategory]} · {formatLatency(log.latencyMs)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              // 桌面端表格视图
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">时间</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">模型</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">站点/账号</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">分类</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">延迟</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Token</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">问题</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {logs.map((log) => (
                    <tr
                      key={log.id}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() => setSelectedLog(log)}
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${STATUS_COLORS[log.status]}`}>
                          {STATUS_LABELS[log.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                        {formatDateTimeLocal(log.createdAt)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                        {log.modelName}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                        <div>{log.siteName || `站点 #${log.siteId}`}</div>
                        <div className="text-xs">{log.accountUsername || `账号 #${log.accountId}`}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                        {CATEGORY_LABELS[log.questionCategory]}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                        {formatLatency(log.latencyMs)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                        {log.tokensUsed || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                        {log.questionText}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="px-4 py-3 flex items-center justify-between border-t border-gray-200">
                <div className="text-sm text-gray-500">
                  共 {total} 条记录，第 {page} / {totalPages} 页
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage(Math.max(1, page - 1))}
                    disabled={page === 1}
                    className="px-3 py-1 border border-gray-300 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                  >
                    上一页
                  </button>
                  <button
                    onClick={() => setPage(Math.min(totalPages, page + 1))}
                    disabled={page === totalPages}
                    className="px-3 py-1 border border-gray-300 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 详情弹窗 */}
      {selectedLog && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedLog(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold">测活详情</h2>
                <button
                  onClick={() => setSelectedLog(null)}
                  className="text-gray-500 hover:text-gray-700"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-sm text-gray-500">状态</div>
                    <div className={`inline-block px-2 py-1 rounded text-sm font-medium ${STATUS_COLORS[selectedLog.status]}`}>
                      {STATUS_LABELS[selectedLog.status]}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500">时间</div>
                    <div className="text-sm">{formatDateTimeLocal(selectedLog.createdAt)}</div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500">模型</div>
                    <div className="text-sm font-medium">{selectedLog.modelName}</div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500">分类</div>
                    <div className="text-sm">{CATEGORY_LABELS[selectedLog.questionCategory]}</div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500">站点</div>
                    <div className="text-sm">{selectedLog.siteName || `#${selectedLog.siteId}`}</div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500">账号</div>
                    <div className="text-sm">{selectedLog.accountUsername || `#${selectedLog.accountId}`}</div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500">延迟</div>
                    <div className="text-sm">{formatLatency(selectedLog.latencyMs)}</div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500">Token</div>
                    <div className="text-sm">{selectedLog.tokensUsed || '-'}</div>
                  </div>
                </div>

                {selectedLog.errorMessage && (
                  <div>
                    <div className="text-sm text-gray-500 mb-1">错误信息</div>
                    <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">
                      {selectedLog.errorMessage}
                    </div>
                  </div>
                )}

                <div>
                  <div className="text-sm text-gray-500 mb-1">问题</div>
                  <div className="bg-gray-50 border border-gray-200 rounded p-3 text-sm whitespace-pre-wrap">
                    {selectedLog.questionText}
                  </div>
                </div>

                {selectedLog.responseText && (
                  <div>
                    <div className="text-sm text-gray-500 mb-1">回答</div>
                    <div className="bg-gray-50 border border-gray-200 rounded p-3 text-sm whitespace-pre-wrap max-h-96 overflow-y-auto">
                      {renderResponseText(selectedLog.responseText)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
