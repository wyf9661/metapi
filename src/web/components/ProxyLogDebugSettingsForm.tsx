import type { Dispatch, ReactNode, SetStateAction } from 'react';
import ResponsiveFormGrid from './ResponsiveFormGrid.js';
import type { ProxyDebugSettingsState } from '../pages/helpers/proxyLogsHelpers.js';
import {
  debugCheckboxRowStyle,
  formInputStyle,
  formSectionLabelStyle,
  formSectionStyle,
} from '../pages/helpers/proxyLogsUi.js';
import { tr } from '../i18n.js';

/**
 * Debug-trace settings form, split out of ProxyLogs.tsx: it is pure JSX driven
 * by the draft settings and their setter, so the page keeps only the state it
 * must own. The footer is injected because the page decides where it goes
 * (inline on mobile, modal footer on desktop).
 */
export function ProxyLogDebugSettingsForm({
  settings,
  onChange,
  isMobile,
  footer,
}: {
  settings: ProxyDebugSettingsState;
  onChange: Dispatch<SetStateAction<ProxyDebugSettingsState>>;
  isMobile: boolean;
  footer: ReactNode;
}) {
  return (
      <div style={{ display: 'grid', gap: 12 }}>
        <div className="info-tip" style={{ marginBottom: 0 }}>{tr('只记录开启后的新请求。需要更精确定位时，再按 Session、客户端或模型定向过滤。')}</div>

        <div style={formSectionStyle}>
          <div style={formSectionLabelStyle}>{tr('记录内容')}</div>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={debugCheckboxRowStyle}>
                <input
                  type="checkbox"
                  checked={settings.proxyDebugTraceEnabled}
                  data-debug-setting="trace-enabled"
                  onChange={(e) =>
                    onChange((current) => ({
                      ...current,
                      proxyDebugTraceEnabled: !!e.target.checked,
                    }))
                  }
                />{tr('开启调试追踪')}</label>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-muted)',
                  marginLeft: 24,
                }}
              >{tr('后续新请求会写入调试追踪，不会回补旧请求。')}</div>
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={debugCheckboxRowStyle}>
                <input
                  type="checkbox"
                  checked={settings.proxyDebugCaptureHeaders}
                  data-debug-setting="capture-headers"
                  onChange={(e) =>
                    onChange((current) => ({
                      ...current,
                      proxyDebugCaptureHeaders: !!e.target.checked,
                    }))
                  }
                />{tr('采集原始请求/响应头')}</label>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-muted)',
                  marginLeft: 24,
                }}
              >{tr('保留下游原始头和上游响应头，方便直接对照。')}</div>
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={debugCheckboxRowStyle}>
                <input
                  type="checkbox"
                  checked={settings.proxyDebugCaptureBodies}
                  data-debug-setting="capture-bodies"
                  onChange={(e) =>
                    onChange((current) => ({
                      ...current,
                      proxyDebugCaptureBodies: !!e.target.checked,
                    }))
                  }
                />{tr('采集请求体和响应体')}</label>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-muted)',
                  marginLeft: 24,
                }}
              >{tr('默认不抓 body，只有显式开启后才记录。')}</div>
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={debugCheckboxRowStyle}>
                <input
                  type="checkbox"
                  checked={settings.proxyDebugCaptureStreamChunks}
                  data-debug-setting="capture-stream-chunks"
                  onChange={(e) =>
                    onChange((current) => ({
                      ...current,
                      proxyDebugCaptureStreamChunks: !!e.target.checked,
                    }))
                  }
                />{tr('采集流式原始分片')}</label>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-muted)',
                  marginLeft: 24,
                }}
              >{tr('适合定位 SSE / streaming 过程中的兼容问题。')}</div>
            </div>
          </div>
        </div>

        <ResponsiveFormGrid columns={2}>
          <div style={formSectionStyle}>
            <div style={formSectionLabelStyle}>{tr('定向过滤')}</div>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('目标 Session ID')}</span>
              <input
                type="text"
                value={settings.proxyDebugTargetSessionId}
                data-debug-setting="target-session-id"
                onChange={(e) =>
                  onChange((current) => ({
                    ...current,
                    proxyDebugTargetSessionId: e.target.value,
                  }))
                }
                placeholder={tr('留空表示不过滤')}
                style={formInputStyle}
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('目标客户端')}</span>
              <input
                type="text"
                value={settings.proxyDebugTargetClientKind}
                data-debug-setting="target-client-kind"
                onChange={(e) =>
                  onChange((current) => ({
                    ...current,
                    proxyDebugTargetClientKind: e.target.value,
                  }))
                }
                placeholder={tr('如 codex / claude_code')}
                style={formInputStyle}
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('目标模型')}</span>
              <input
                type="text"
                value={settings.proxyDebugTargetModel}
                data-debug-setting="target-model"
                onChange={(e) =>
                  onChange((current) => ({
                    ...current,
                    proxyDebugTargetModel: e.target.value,
                  }))
                }
                placeholder={tr('如 gpt-4o')}
                style={formInputStyle}
              />
            </label>
          </div>

          <div style={formSectionStyle}>
            <div style={formSectionLabelStyle}>{tr('保留策略')}</div>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('保留时长（小时）')}</span>
              <input
                type="number"
                min={1}
                value={settings.proxyDebugRetentionHours}
                data-debug-setting="retention-hours"
                onChange={(e) =>
                  onChange((current) => ({
                    ...current,
                    proxyDebugRetentionHours: Number(e.target.value || 1),
                  }))
                }
                style={formInputStyle}
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('抓取体积上限（字节）')}</span>
              <input
                type="number"
                min={1024}
                value={settings.proxyDebugMaxBodyBytes}
                data-debug-setting="max-body-bytes"
                onChange={(e) =>
                  onChange((current) => ({
                    ...current,
                    proxyDebugMaxBodyBytes: Number(e.target.value || 1024),
                  }))
                }
                style={formInputStyle}
              />
            </label>
          </div>
        </ResponsiveFormGrid>

        {isMobile ? footer : null}
      </div>
  
  );
}

/** Footer actions for the debug settings modal. */
export function ProxyLogDebugSettingsFooter({
  onReset,
  onSave,
  saving,
}: {
  onReset: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onReset()}
        >{tr('重置为默认值')}</button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onSave()}
          disabled={saving}
        >
          {saving ? '保存中...' : '保存调试设置'}
        </button>
      </div>
  
  );
}
