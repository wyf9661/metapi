import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import ModernSelect from '../components/ModernSelect.js';
import { tr } from '../i18n.js';

type RemoteProtocol = 'completion' | 'anthropic' | 'responses';

type RemoteProbeResult = {
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  requestUrl?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  responseText?: string;
  models?: string[];
  previewText?: string;
  error?: string;
};

const STORAGE_KEY = 'metapi.model-check.v1';
const DEFAULT_PROMPT = 'Reply with a single word: ok';

const PROTOCOL_OPTIONS: Array<{ value: RemoteProtocol; label: string }> = [
  { value: 'completion', label: 'OpenAI Completions (/v1/chat/completions)' },
  { value: 'anthropic', label: 'Anthropic Messages (/v1/messages)' },
  { value: 'responses', label: 'OpenAI Responses (/v1/responses)' },
];

const inputBaseStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  fontSize: 13,
  boxSizing: 'border-box',
};

function formatJson(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function statusColor(ok: boolean | null, running: boolean): string {
  if (running) return 'var(--color-warning, #d97706)';
  if (ok === true) return 'var(--color-success, #16a34a)';
  if (ok === false) return 'var(--color-danger, #dc2626)';
  return 'var(--color-text-muted)';
}

export default function ModelTester() {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<RemoteProtocol>('completion');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);

  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState('');
  const [listResult, setListResult] = useState<RemoteProbeResult | null>(null);

  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [probeResult, setProbeResult] = useState<RemoteProbeResult | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        baseUrl?: string;
        protocol?: RemoteProtocol;
        model?: string;
      };
      if (typeof parsed.baseUrl === 'string') setBaseUrl(parsed.baseUrl);
      if (parsed.protocol === 'completion' || parsed.protocol === 'anthropic' || parsed.protocol === 'responses') {
        setProtocol(parsed.protocol);
      }
      if (typeof parsed.model === 'string') setModel(parsed.model);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        baseUrl,
        protocol,
        model,
      }));
    } catch {
      // ignore
    }
  }, [baseUrl, model, protocol]);

  const modelOptions = useMemo(
    () => models.map((name) => ({ value: name, label: name })),
    [models],
  );

  const canList = baseUrl.trim().length > 0 && apiKey.trim().length > 0 && !listing;
  const canProbe = canList && models.length > 0 && model.trim().length > 0 && models.includes(model) && !probing;

  const listModels = useCallback(async () => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      setListError('请填写 Base URL 和 API Key');
      return;
    }

    setListing(true);
    setListError('');
    setListResult(null);
    setProbeResult(null);
    setProbeError('');

    try {
      const result = await api.listRemoteUpstreamModels({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
      }) as RemoteProbeResult;

      setListResult(result);
      const nextModels = Array.isArray(result.models) ? result.models : [];
      setModels(nextModels);

      if (!result.ok) {
        setModel('');
        setListError(result.error || '拉取模型列表失败');
        return;
      }

      if (nextModels.length === 0) {
        setModel('');
        setListError('上游返回了空模型列表');
        return;
      }

      setModel((prev) => (prev && nextModels.includes(prev) ? prev : nextModels[0]));
    } catch (error: any) {
      setModels([]);
      setModel('');
      setListError(error?.message || '拉取模型列表失败');
    } finally {
      setListing(false);
    }
  }, [apiKey, baseUrl]);

  const probeModel = useCallback(async () => {
    if (!baseUrl.trim() || !apiKey.trim() || !model.trim() || !models.includes(model)) {
      setProbeError('请先拉取模型列表并选择模型');
      return;
    }

    setProbing(true);
    setProbeError('');
    setProbeResult(null);

    try {
      const result = await api.probeRemoteUpstream({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        protocol,
        model: model.trim(),
        prompt: DEFAULT_PROMPT,
        maxTokens: 16,
      }) as RemoteProbeResult;

      setProbeResult(result);
      if (!result.ok) {
        setProbeError(result.error || `HTTP ${result.statusCode || 0}`);
      }
    } catch (error: any) {
      setProbeError(error?.message || '检测失败');
    } finally {
      setProbing(false);
    }
  }, [apiKey, baseUrl, model, models, protocol]);

  const clearAll = useCallback(() => {
    setListError('');
    setListResult(null);
    setModels([]);
    setModel('');
    setProbeError('');
    setProbeResult(null);
  }, []);

  const probeOk = probing ? null : (probeResult ? probeResult.ok : null);

  return (
    <div className="animate-fade-in" style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <h2 className="page-title">{tr('模型检测')}</h2>
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
            用临时 Base URL + Key 拉取模型，检测该模型在选定协议下是否可用。
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 600 }}>
              Base URL
            </div>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com 或 …/v1"
              style={inputBaseStyle}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 600 }}>
              API Key
            </div>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-..."
              style={inputBaseStyle}
              autoComplete="off"
              spellCheck={false}
              type="password"
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 600 }}>
              协议
            </div>
            <ModernSelect
              value={protocol}
              onChange={(next) => {
                if (next === 'completion' || next === 'anthropic' || next === 'responses') {
                  setProtocol(next);
                  setProbeResult(null);
                  setProbeError('');
                }
              }}
              options={PROTOCOL_OPTIONS}
              placeholder="选择协议"
            />
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { void listModels(); }}
              disabled={!canList}
              style={{ flex: '1 1 140px' }}
            >
              {listing ? '拉取中…' : '拉取模型列表'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)', flex: '0 0 auto' }}
              onClick={clearAll}
            >
              清空
            </button>
          </div>

          {listError ? (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-danger, #dc2626)' }}>
              {listError}
            </div>
          ) : null}
          {!listError && listResult ? (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)' }}>
              列表 {listResult.ok ? 'OK' : 'FAIL'} · {listResult.latencyMs ?? '-'} ms · HTTP {listResult.statusCode ?? '-'}
              {models.length > 0 ? ` · ${models.length} 个模型` : ''}
            </div>
          ) : null}
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 600 }}>
            模型
          </div>
          <ModernSelect
            value={model && models.includes(model) ? model : ''}
            onChange={(next) => {
              if (!next) return;
              if (!models.includes(next)) return;
              setModel(next);
              setProbeResult(null);
              setProbeError('');
            }}
            options={modelOptions}
            placeholder={models.length === 0 ? '暂无模型，请先拉取列表' : '选择模型'}
            disabled={models.length === 0}
            emptyLabel="无匹配模型"
            menuMaxHeight={280}
            searchable
            searchPlaceholder="搜索模型"
          />
          {models.length > 0 ? (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-muted)' }}>
              共 {models.length} 个模型，打开下拉可搜索
            </div>
          ) : null}

          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 14 }}
            onClick={() => { void probeModel(); }}
            disabled={!canProbe}
          >
            {probing ? '检测中…' : '检测模型'}
          </button>
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>结果</h3>
            <div style={{ fontSize: 14, fontWeight: 700, color: statusColor(probeOk, probing) }}>
              {probing ? '检测中' : probeOk === true ? '可用' : probeOk === false ? '不可用' : '未检测'}
            </div>
          </div>

          {!probeResult && !probeError && !probing ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              拉取模型并点击「检测模型」后显示结果。
            </div>
          ) : null}

          {(probeResult || probeError) && !probing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                <div>
                  状态：
                  <strong style={{ color: statusColor(probeOk, false), marginLeft: 6 }}>
                    {probeOk ? '可用' : '不可用'}
                  </strong>
                </div>
                {probeResult ? (
                  <div style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>
                    HTTP {probeResult.statusCode ?? '-'} · {probeResult.latencyMs ?? '-'} ms
                    {probeResult.requestUrl ? (
                      <>
                        <br />
                        {probeResult.requestUrl}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {probeError ? (
                <div style={{ fontSize: 12, color: 'var(--color-danger, #dc2626)', wordBreak: 'break-word' }}>
                  {probeError}
                </div>
              ) : null}

              {probeResult?.previewText ? (
                <div
                  style={{
                    fontSize: 13,
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--color-bg-muted, rgba(0,0,0,0.03))',
                    wordBreak: 'break-word',
                  }}
                >
                  {probeResult.previewText}
                </div>
              ) : null}

              {probeResult ? (
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--color-text-muted)' }}>
                    响应详情
                  </summary>
                  <pre
                    style={{
                      margin: '8px 0 0',
                      padding: 12,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--color-bg-muted, rgba(0,0,0,0.03))',
                      overflow: 'auto',
                      maxHeight: 280,
                      fontSize: 12,
                      lineHeight: 1.45,
                    }}
                  >
                    {formatJson(probeResult.responseBody ?? probeResult.responseText ?? '')}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
