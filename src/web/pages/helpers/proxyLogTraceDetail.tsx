/**
 * Debug-trace detail render helpers for the proxy logs page. Extracted from
 * ProxyLogs.tsx (which was ~3k lines) — pure move, zero behavior change.
 * These are display-only: the copy handler is injected so the module stays
 * free of page state. Types are declared locally to avoid a circular import
 * with ProxyLogs.tsx.
 */
import { DetailDisclosureCard, debugCodeBlockStyle, detailInfoGridStyle, detailInfoItemStyle, detailInfoLabelStyle, detailInfoValueStyle, detailSectionTitleStyle, formSectionStyle } from './proxyLogsUi.js';
import { parseStoredDebugPreview, stringifyStoredDebugValue } from './proxyLogsHelpers.js';
import type { ProxyDebugTraceDetail } from '../../api.js';
import { tr } from '../../i18n.js';

export type ProxyDebugTraceAttempt = ProxyDebugTraceDetail['attempts'][number];

export type ProxyDebugTraceListItemLike = {
  id: number;
  finalStatus?: string | null;
};

export function renderTraceStatusBadge(trace: ProxyDebugTraceListItemLike) {
  const failed = trace.finalStatus === 'failed';
  // Plain coloured text, matching the usage-log status column: no chip, dot or
  // background — the whole column is one repeated value pair, so a filled badge
  // only adds noise and breaks the row baseline.
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: failed ? 600 : 500,
        color: failed ? 'var(--color-danger)' : 'var(--color-success)',
      }}
    >
      {failed ? '失败' : '成功'}
    </span>
  );
}

export function renderStoredDebugDetails(
  title: string,
  value: unknown,
  options: { defaultOpen?: boolean; copyLabel?: string },
  onCopy: (label: string, value: unknown) => void,
) {
  const normalized = parseStoredDebugPreview(value);
  const copyLabel = options?.copyLabel || title;

  return (
    <DetailDisclosureCard title={title} defaultOpen={options?.defaultOpen}>
      <div style={{ padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{
              border: '1px solid var(--color-border)',
              padding: '6px 12px',
            }}
            aria-label={`复制${copyLabel}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void onCopy(copyLabel, value);
            }}
          >{tr('复制当前保存内容')}</button>
        </div>
        {normalized.note ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {normalized.note}
          </div>
        ) : null}
        <pre style={debugCodeBlockStyle}>{normalized.displayText}</pre>
      </div>
    </DetailDisclosureCard>
  );
}

/**
 * One attempt inside a debug trace: the target URL / executor / recovery and
 * downgrade flags as a labelled grid, plus the full serialized exchange (request
 * and response headers, bodies, raw error, memory write) in a code block.
 *
 * Extracted from ProxyLogs.tsx, which called it as a plain map() callback even
 * though it renders JSX.
 */
export function ProxyDebugAttemptDetail({ attempt }: { attempt: ProxyDebugTraceAttempt }) {
  const serializedAttempt = [
    `targetUrl: ${attempt.targetUrl}`,
    `runtimeExecutor: ${attempt.runtimeExecutor || '-'}`,
    `recoverApplied: ${attempt.recoverApplied ? 'true' : 'false'}`,
    `downgradeDecision: ${attempt.downgradeDecision ? 'true' : 'false'}`,
    `downgradeReason: ${attempt.downgradeReason || '-'}`,
    '',
    'requestHeaders:',
    stringifyStoredDebugValue(attempt.requestHeadersJson) || '-',
    '',
    'requestBody:',
    stringifyStoredDebugValue(attempt.requestBodyJson) || '-',
    '',
    'responseHeaders:',
    stringifyStoredDebugValue(attempt.responseHeadersJson) || '-',
    '',
    'responseBody:',
    stringifyStoredDebugValue(attempt.responseBodyJson) || '-',
    '',
    'rawErrorText:',
    attempt.rawErrorText || '-',
    '',
    'memoryWrite:',
    stringifyStoredDebugValue(attempt.memoryWriteJson) || '-',
  ].join('\n');

  return (
    <DetailDisclosureCard
      key={attempt.id}
      title={`#${attempt.attemptIndex + 1} · ${attempt.endpoint} · ${attempt.responseStatus ?? '-'} · ${attempt.requestPath}`}
    >
      <div style={{ padding: 12, display: 'grid', gap: 12 }}>
        <div style={detailInfoGridStyle}>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>{tr('目标地址')}</div>
            <div
              style={{
                ...detailInfoValueStyle,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
              }}
            >
              {attempt.targetUrl || '-'}
            </div>
          </div>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>{tr('执行器')}</div>
            <div style={detailInfoValueStyle}>
              {attempt.runtimeExecutor || '-'}
            </div>
          </div>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>{tr('恢复逻辑')}</div>
            <div style={detailInfoValueStyle}>
              {attempt.recoverApplied ? '已应用' : '未应用'}
            </div>
          </div>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>{tr('降级决策')}</div>
            <div style={detailInfoValueStyle}>
              {attempt.downgradeDecision ? '已触发' : '未触发'}
            </div>
          </div>
        </div>
        {attempt.downgradeReason ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            降级原因：{attempt.downgradeReason}
          </div>
        ) : null}
        <pre style={debugCodeBlockStyle}>{serializedAttempt}</pre>
      </div>
    </DetailDisclosureCard>
  );
}

/** Load state of the selected debug trace, as the page tracks it. */
export type ProxyDebugTraceDetailState = {
  loading: boolean;
  data?: ProxyDebugTraceDetail;
  error?: string;
};

/**
 * The debug-trace detail panel: empty / loading / error / no-data states, the
 * basic-info grid, the stored debug payloads and the attempt list.
 *
 * Extracted from ProxyLogs.tsx. It reads nothing from the page directly — the
 * selected trace and its load state come in as props, and the copy handler is
 * injected so this module stays free of page state (same pattern as the other
 * helpers here).
 */
export function ProxyDebugTraceDetailPanel({
selectedDebugTraceId,
detail,
onCopyStoredDebugValue,
}: {
selectedDebugTraceId: number | null;
detail?: ProxyDebugTraceDetailState;
onCopyStoredDebugValue: (label: string, value: unknown) => void;
}) {
  if (!selectedDebugTraceId) {
    return (
      <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{tr('暂无追踪详情。请选择一条最近追踪后再查看。')}</div>
    );
  }

  if (detail?.loading) {
    return (
      <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{tr('加载追踪详情中...')}</div>
    );
  }

  if (detail?.error) {
    return (
      <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>
        {detail.error}
      </div>
    );
  }

  if (!detail?.data) {
    return (
      <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{tr('暂无追踪详情。')}</div>
    );
  }

  const traceDetail = detail.data.trace;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ ...formSectionStyle, gap: 10 }}>
        <div style={detailSectionTitleStyle}>{tr('基础信息')}</div>
        <div style={detailInfoGridStyle}>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>{tr('下游路径')}</div>
            <div style={detailInfoValueStyle}>
              {traceDetail.downstreamPath || '-'}
            </div>
          </div>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>Session</div>
            <div style={detailInfoValueStyle}>
              {traceDetail.sessionId || '-'}
            </div>
          </div>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>{tr('模型')}</div>
            <div style={detailInfoValueStyle}>
              {traceDetail.requestedModel || '-'}
            </div>
          </div>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>{tr('最终上游路径')}</div>
            <div style={detailInfoValueStyle}>
              {traceDetail.finalUpstreamPath || '-'}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        {renderStoredDebugDetails(
          '候选 endpoint',
          traceDetail.endpointCandidatesJson,
          {
            copyLabel: '候选 endpoint',
          }, onCopyStoredDebugValue,
        )}
        {renderStoredDebugDetails(
          '原始下游请求头',
          traceDetail.requestHeadersJson,
          {
            copyLabel: '原始下游请求头',
          }, onCopyStoredDebugValue,
        )}
        {renderStoredDebugDetails(
          '原始下游请求体',
          traceDetail.requestBodyJson,
          {
            copyLabel: '原始下游请求体',
          }, onCopyStoredDebugValue,
        )}
        {renderStoredDebugDetails(
          '最终响应',
          traceDetail.finalResponseBodyJson,
          {
            copyLabel: '最终响应',
          }, onCopyStoredDebugValue,
        )}
      </div>

      <DetailDisclosureCard
        title={`Attempt 记录 (${detail.data.attempts.length})`}
      >
        <div style={{ padding: 12, display: 'grid', gap: 8 }}>
          {detail.data.attempts.length === 0 ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{tr('暂无 attempt 记录')}</div>
          ) : (
            detail.data.attempts.map((attempt) => (
              <ProxyDebugAttemptDetail key={attempt.id} attempt={attempt} />
            ))
          )}
        </div>
      </DetailDisclosureCard>
    </div>
  );
}
