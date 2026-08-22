/**
 * @Author: 橘子
 * @Project_description: Metapi 站点管理页
 * @Description: 代码是我抄的，不会也是真的
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type OAuthProviderInfo } from '../api.js';
import { getAuthToken } from '../authSession.js';
import { getBrand } from '../components/BrandIcon.js';
import CenteredModal from '../components/CenteredModal.js';
import ResponsiveFilterPanel from '../components/ResponsiveFilterPanel.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import ResponsiveFormGrid from '../components/ResponsiveFormGrid.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { pageForItemIndex, CLIENT_PAGE_SIZE } from '../components/clientPagination.js';
import PaginationControls from '../components/PaginationControls.js';
import { useClientPagination, useExactPageSize } from '../components/useClientPagination.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.js';
import SiteCreatedModal from '../components/SiteCreatedModal.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';
import { clearFocusParams, readFocusSiteId } from './helpers/navigationFocus.js';
import {SITE_PLATFORM_OPTIONS, SiteBalanceDisplay, buildSiteConnectionSearchParams, getConfiguredSiteApiEndpoints, platformColors, resolveSiteCreatedSessionLabel} from './sites/sitePresentation.js';
import { tr } from '../i18n.js';
import { buildCustomReorderUpdates, buildUnpinMoveToFrontUpdates, sortItemsForDisplay, type SortMode } from './helpers/listSorting.js';
import { resolveInitialConnectionSegment } from './helpers/defaultConnectionSegment.js';
import {
  applyCodexCompatibilityMode,
  buildSiteSaveAction,
  emptySiteApiEndpoint,
  emptySiteCustomHeader,
  emptySiteForm,
  isCodexCompatibilityModeEnabled,
  serializeSiteApiEndpoints,
  serializeSiteCustomHeaders,
  siteFormFromSite,
  type SiteEditorState,
  type SiteApiEndpointField,
  type SiteForm,
} from './helpers/sitesEditor.js';
import {
  detectSiteInitializationPreset,
  getSiteInitializationPreset,
} from '../../shared/siteInitializationPresets.js';
import { analyzePrimarySiteUrl } from '../../shared/sitePrimaryUrl.js';

type SiteSubscriptionSummary = {
  activeCount: number;
  totalUsedUsd: number;
  totalMonthlyLimitUsd?: number | null;
  totalRemainingUsd?: number | null;
  nextExpiresAt?: string | null;
  planNames?: string[];
  updatedAt?: number | null;
};

type SiteRow = {
  id: number;
  name: string;
  url: string;
  platform?: string;
  status?: string;
  proxyUrl?: string | null;
  customHeaders?: string | null;
  customHeadersOverrideRequestHeaders?: boolean | null;
  globalWeight?: number;
  isPinned?: boolean;
  sortOrder?: number;
  totalBalance?: number;
  totalBalanceUsed?: number;
  todayReward?: number;
  todaySpend?: number;
  subscriptionSummary?: SiteSubscriptionSummary | null;
  healthState?: {
    state: 'healthy' | 'unhealthy' | 'degraded' | 'unknown' | 'disabled';
    reason: string;
    source: string;
    checkedAt: string | null;
  };
  connectionStats?: {
    accounts: number;
    sessions: number;
    apiKeys: number;
    tokens: number;
    oauth: number;
  } | null;
  createdAt?: string;
  postRefreshProbeEnabled?: boolean;
  postRefreshProbeModel?: string | null;
  postRefreshProbeScope?: string | null;
  postRefreshProbeLatencyThresholdMs?: number | null;
  apiEndpoints?: Array<{
    id?: number;
    url: string;
    enabled?: boolean;
    sortOrder?: number;
    cooldownUntil?: string | null;
    lastFailureReason?: string | null;
  }>;
};


export default function Sites() {
  const location = useLocation();
  const navigate = useNavigate();
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('custom');
  const [highlightSiteId, setHighlightSiteId] = useState<number | null>(null);
  const [editor, setEditor] = useState<SiteEditorState | null>(null);
  const apiEndpointDraftIdRef = useRef(0);
  const createApiEndpointDraftId = () => {
    apiEndpointDraftIdRef.current += 1;
    return `site-api-endpoint-draft-${apiEndpointDraftIdRef.current}`;
  };
  const createEmptyApiEndpointRow = (): SiteApiEndpointField => ({
    ...emptySiteApiEndpoint(),
    draftId: createApiEndpointDraftId(),
  });
  const hydrateSiteForm = (value: SiteForm): SiteForm => {
    const sourceRows = value.apiEndpoints.length > 0 ? value.apiEndpoints : [createEmptyApiEndpointRow()];
    return {
      ...value,
      apiEndpoints: sourceRows.map((endpoint) => ({
        ...endpoint,
        draftId: endpoint.draftId || createApiEndpointDraftId(),
      })),
    };
  };
  const createEmptySiteForm = (): SiteForm => hydrateSiteForm(emptySiteForm());
  const [form, setForm] = useState<SiteForm>(() => createEmptySiteForm());
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [togglingSiteId, setTogglingSiteId] = useState<number | null>(null);
  const [orderingSiteId, setOrderingSiteId] = useState<number | null>(null);
  const [pinningSiteId, setPinningSiteId] = useState<number | null>(null);
  const [expandedSiteIds, setExpandedSiteIds] = useState<number[]>([]);
  const [createdSiteForChoice, setCreatedSiteForChoice] = useState<{
    id: number;
    name: string;
    platform?: string | null;
    initializationPresetId?: string | null;
  } | null>(null);
  const [selectedInitializationPresetId, setSelectedInitializationPresetId] = useState<string | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderInfo[]>([]);
  const isMobile = useIsMobile();
  const [showMobileTools, setShowMobileTools] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<null | {
    mode: 'single';
    siteId?: number;
    siteName?: string;
  }>(null);
  const lastEditorRef = useRef<SiteEditorState | null>(null);
  const loadingModelsSiteIdRef = useRef<number | null>(null);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const sitesTableWrapRef = useRef<HTMLDivElement | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const toast = useToast();
  const [disabledModels, setDisabledModels] = useState<string[]>([]);
  const [disabledModelInput, setDisabledModelInput] = useState('');
  const [disabledModelsLoading, setDisabledModelsLoading] = useState(false);
  const [disabledModelsSaving, setDisabledModelsSaving] = useState(false);
  const [probeEnabled, setProbeEnabled] = useState(false);
  const [probeModel, setProbeModel] = useState('');
  const [probeScope, setProbeScope] = useState<'single' | 'all'>('single');
  const [probeSaving, setProbeSaving] = useState(false);
  const [probeLatencyThreshold, setProbeLatencyThreshold] = useState('0');
  const [probing, setProbing] = useState(false);
  type ProbeLogEntry = { time: string; text: string; color?: string };
  const [probeLog, setProbeLog] = useState<ProbeLogEntry[]>([]);
  const [probeCompleted, setProbeCompleted] = useState(false);
  const probeAbortRef = useRef<AbortController | null>(null);
  const probeLogEndRef = useRef<HTMLDivElement | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [disabledModelSearch, setDisabledModelSearch] = useState('');
  const selectedInitializationPreset = useMemo(
    () => getSiteInitializationPreset(selectedInitializationPresetId),
    [selectedInitializationPresetId],
  );
  const primarySiteUrlAnalysis = useMemo(() => analyzePrimarySiteUrl(form.url), [form.url]);
  const latestPrimarySiteUrlRef = useRef(form.url);
  const latestPlatformRef = useRef(form.platform);
  const latestInitializationPresetIdRef = useRef(selectedInitializationPresetId);

  useEffect(() => {
    void api.getOAuthProviders()
      .then((response) => setOauthProviders(Array.isArray(response?.providers) ? response.providers : []))
      .catch(() => setOauthProviders([]));
  }, []);

  useEffect(() => {
    latestPrimarySiteUrlRef.current = form.url;
  }, [form.url]);

  useEffect(() => {
    latestPlatformRef.current = form.platform;
  }, [form.platform]);

  useEffect(() => {
    latestInitializationPresetIdRef.current = selectedInitializationPresetId;
  }, [selectedInitializationPresetId]);

  useEffect(() => {
    if (!editor) {
      probeAbortRef.current?.abort();
      probeAbortRef.current = null;
    }
  }, [editor]);

  useEffect(() => () => {
    probeAbortRef.current?.abort();
    probeAbortRef.current = null;
  }, []);

  const disabledModelSet = useMemo(() => new Set(disabledModels), [disabledModels]);

  const brandGroups = useMemo(() => {
    const allModels = Array.from(new Set([...availableModels, ...disabledModels]));
    const groups = new Map<string, string[]>();
    for (const model of allModels) {
      const brand = getBrand(model);
      const brandName = brand?.name || '其他';
      if (!groups.has(brandName)) groups.set(brandName, []);
      groups.get(brandName)!.push(model);
    }
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === '其他') return 1;
      if (b[0] === '其他') return -1;
      return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
    });
  }, [availableModels, disabledModels]);

  const filteredBrandGroups = useMemo(() => {
    const q = String(disabledModelSearch ?? '').trim().toLowerCase();
    if (!q) return brandGroups;
    return brandGroups
      .map(([brandName, models]) => [brandName, models.filter((m) => m.toLowerCase().includes(q))] as [string, string[]])
      .filter(([, models]) => models.length > 0);
  }, [brandGroups, disabledModelSearch]);

  if (editor) lastEditorRef.current = editor;
  const activeEditor = editor || lastEditorRef.current;
  const isEditing = activeEditor?.mode === 'edit';
  const isAdding = editor?.mode === 'add';
  const formInputStyle = {
    width: '100%',
    padding: '10px 14px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    outline: 'none',
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
  } as const;

  const load = async () => {
    try {
      const rows = await api.getSites();
      setSites(rows || []);
    } catch {
      toast.error('加载站点列表失败');
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const sortedSites = useMemo(
    () => sortItemsForDisplay(sites, sortMode, (site) => site.totalBalance || 0),
    [sites, sortMode],
  );
  const exactPageSize = useExactPageSize(sitesTableWrapRef, {
    min: 4,
    max: 30,
    rowSelector: 'tbody tr',
  });
  const effectivePageSize = isMobile ? CLIENT_PAGE_SIZE : exactPageSize;
  const {
    page: safePage,
    setPage,
    totalPages,
    pageSize,
    pagedItems: pagedSites,
    showControls: showSitePagination,
  } = useClientPagination(sortedSites, `${sortMode}:${sites.length}`, effectivePageSize);

  // 页码持久化到 URL（?page=N），跳详情页返回后仍停留在原页。
  useEffect(() => {
    const urlPage = Number.parseInt(new URLSearchParams(location.search).get('page') || '', 10);
    if (Number.isFinite(urlPage) && urlPage >= 1 && urlPage !== safePage) {
      setPage(urlPage);
    }
  }, [location.search, safePage, setPage]);

  const normalizedFormPlatform = String(form.platform ?? '').trim();
  const platformOptions = useMemo(() => {
    const current = normalizedFormPlatform;
    const oauthPlatformIds = new Set(oauthProviders.map((provider) => provider.platform));
    const genericPlatformOptions = SITE_PLATFORM_OPTIONS
      .filter((option) => !oauthPlatformIds.has(option.value))
      .map((option) => option.value === 'claude'
        ? { ...option, label: 'claude API', description: '通用 Claude / Anthropic API 接入' }
        : option);
    const genericOptions = (!current || genericPlatformOptions.some((option) => option.value === current))
      ? genericPlatformOptions
      : [
        ...genericPlatformOptions,
        { value: current, label: `${current}（当前值）` },
      ];
    const oauthOptions = oauthProviders.map((provider) => ({
      value: provider.platform,
      label: `${provider.label} OAuth`,
      description: provider.requiresProjectId
        ? 'OAuth 登录，需 Google Cloud Project ID；官方地址自动配置'
        : 'OAuth 登录；官方地址自动配置',
    }));
    return [
      genericOptions[0]!,
      { value: '__api_group__', label: 'API / 聚合平台', disabled: true },
      ...genericOptions.slice(1),
      { value: '__oauth_group__', label: 'OAuth / CLI 平台', disabled: true },
      ...oauthOptions,
    ];
  }, [normalizedFormPlatform, oauthProviders]);
  const selectedOauthProvider = useMemo(
    () => oauthProviders.find((provider) => provider.platform === normalizedFormPlatform) || null,
    [normalizedFormPlatform, oauthProviders],
  );
  const platformSelectValue = form.platform;

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const focusSiteId = readFocusSiteId(location.search);
    if (!focusSiteId || !loaded) return;

    const cleanedSearch = clearFocusParams(location.search);
    const targetIndex = sortedSites.findIndex((site) => site.id === focusSiteId);
    if (targetIndex < 0) {
      navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
      return;
    }
    const targetPage = pageForItemIndex(targetIndex, pageSize);
    if (targetPage !== safePage) {
      setPage(targetPage);
      return;
    }

    const row = rowRefs.current.get(focusSiteId);
    if (!row) {
      return;
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightSiteId(focusSiteId);
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightSiteId((current) => (current === focusSiteId ? null : current));
    }, 2200);

    navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
  }, [loaded, location.pathname, location.search, navigate, pageSize, safePage, sortedSites]);

  const closeEditor = () => {
    setEditor(null);
    setForm(createEmptySiteForm());
    setSelectedInitializationPresetId(null);
  };

  const scrollToEditorTop = () => {
    const scrollTo = (globalThis as { scrollTo?: (options?: ScrollToOptions) => void }).scrollTo;
    if (typeof scrollTo === 'function') {
      scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const openAdd = () => {
    if (isAdding) {
      closeEditor();
      return;
    }
    setEditor({ mode: 'add' });
    setForm(createEmptySiteForm());
    setSelectedInitializationPresetId(null);
    scrollToEditorTop();
  };

  const openEdit = (site: SiteRow) => {
    setEditor({ mode: 'edit', editingSiteId: site.id });
    setForm(hydrateSiteForm(siteFormFromSite(site)));
    setSelectedInitializationPresetId(detectSiteInitializationPreset(site.url, site.platform)?.id || null);
    scrollToEditorTop();
    // Load disabled models and discovered models independently so a best-effort
    // availability fetch cannot wipe the existing disabled-model state.
    const loadSiteId = site.id;
    loadingModelsSiteIdRef.current = loadSiteId;
    setDisabledModelsLoading(true);
    setDisabledModels([]);
    setDisabledModelInput('');
    setAvailableModels([]);
    setDisabledModelSearch('');
    setProbeEnabled(!!site.postRefreshProbeEnabled);
    setProbeModel(typeof site.postRefreshProbeModel === 'string' ? site.postRefreshProbeModel : '');
    setProbeScope(site.postRefreshProbeScope === 'all' ? 'all' : 'single');
    setProbeLatencyThreshold(String(site.postRefreshProbeLatencyThresholdMs ?? 0));
    setProbeLog([]);
    setProbeCompleted(false);
    probeAbortRef.current?.abort();
    probeAbortRef.current = null;
    let pendingLoads = 2;
    const markLoadFinished = () => {
      pendingLoads -= 1;
      if (pendingLoads <= 0 && loadingModelsSiteIdRef.current === loadSiteId) {
        setDisabledModelsLoading(false);
      }
    };

    api.getSiteDisabledModels(site.id)
      .then((disabledRes: any) => {
        if (loadingModelsSiteIdRef.current !== loadSiteId) return;
        setDisabledModels(Array.isArray(disabledRes?.models) ? disabledRes.models : []);
      })
      .catch((err: any) => {
        console.warn('Failed to load site disabled models:', err?.message || err);
      })
      .finally(markLoadFinished);

    api.getSiteAvailableModels(site.id)
      .then((availableRes: any) => {
        if (loadingModelsSiteIdRef.current !== loadSiteId) return;
        setAvailableModels(Array.isArray(availableRes?.models) ? availableRes.models : []);
      })
      .catch((err: any) => {
        console.warn('Failed to load site available models:', err?.message || err);
      })
      .finally(markLoadFinished);
  };

  const handleAddDisabledModel = () => {
    const model = String(disabledModelInput ?? '').trim();
    if (!model) return;
    if (disabledModels.includes(model)) {
      toast.info(`模型 "${model}" 已在禁用列表中`);
      setDisabledModelInput('');
      return;
    }
    setDisabledModels((prev) => [...prev, model]);
    setDisabledModelInput('');
  };

  const handleSaveDisabledModels = async () => {
    if (!editor || editor.mode !== 'edit') return;
    setDisabledModelsSaving(true);
    try {
      await api.updateSiteDisabledModels(editor.editingSiteId, disabledModels);
      try {
        await api.rebuildRoutes(false, false);
        toast.success('禁用模型列表已保存，路由已重建');
      } catch {
        toast.error('禁用模型列表已保存，但路由重建失败，请手动刷新路由');
      }
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || '保存禁用模型失败');
    } finally {
      setDisabledModelsSaving(false);
    }
  };

  const handleSaveProbeSettings = async () => {
    if (!editor || editor.mode !== 'edit') return;
    setProbeSaving(true);
    try {
      await api.updateSite(editor.editingSiteId, {
        postRefreshProbeEnabled: probeEnabled,
        postRefreshProbeModel: String(probeModel ?? '').trim(),
        postRefreshProbeScope: probeScope,
        postRefreshProbeLatencyThresholdMs: Math.max(0, parseInt(probeLatencyThreshold, 10) || 0),
      });
      setSites((prev) => prev.map((s) => s.id === editor.editingSiteId
        ? { ...s, postRefreshProbeEnabled: probeEnabled, postRefreshProbeModel: String(probeModel ?? '').trim(), postRefreshProbeScope: probeScope, postRefreshProbeLatencyThresholdMs: Math.max(0, parseInt(probeLatencyThreshold, 10) || 0) }
        : s,
      ));
      toast.success('刷新后探测设置已保存');
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || '保存失败');
    } finally {
      setProbeSaving(false);
    }
  };

  const handleProbeNow = async () => {
    if (!editor || editor.mode !== 'edit') return;
    const siteId = editor.editingSiteId;
    const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const addLog = (text: string, color?: string) =>
      setProbeLog((prev) => [...prev, { time: now(), text, color }]);

    probeAbortRef.current?.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;
    setProbing(true);
    setProbeLog([]);
    setProbeCompleted(false);

    try {
      const token = getAuthToken(localStorage);
      const params = new URLSearchParams({ scope: probeScope });
      if (probeScope === 'single' && String(probeModel ?? '').trim()) params.set('modelName', String(probeModel ?? '').trim());
      const threshold = parseInt(probeLatencyThreshold, 10);
      if (Number.isFinite(threshold) && threshold > 0) params.set('latencyThresholdMs', String(threshold));

      const res = await fetch(`/api/sites/${siteId}/probe-stream?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let errMsg = `连接失败 (HTTP ${res.status})`;
        try { const j = await res.json() as any; errMsg = j?.error || j?.message || errMsg; } catch { /* ignore */ }
        addLog(errMsg, 'var(--color-error, #dc2626)');
        toast.error(errMsg);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const handleSseEvent = (type: string, rawData: string) => {
        try {
          const d = JSON.parse(rawData);
          if (type === 'start') {
            addLog(`开始探测，范围：${d.scope === 'all' ? '全部模型' : '指定模型'}，共 ${d.modelsCount} 个`);
          } else if (type === 'model') {
            const s = d.status === 'supported' ? '✓ 可用'
              : d.status === 'unsupported'
                ? (d.latencyExceeded ? `✗ 延迟超限 (${d.latencyMs}ms)` : '✗ 不可用')
              : d.status === 'skipped' ? '— 已跳过'
              : '✗ 不可用';
            const lat = d.latencyMs != null && d.status !== 'skipped' ? ` (${d.latencyMs}ms)` : '';
            const c = d.status === 'supported' ? 'var(--color-success, #16a34a)'
              : d.status === 'skipped' ? 'var(--color-text-muted)'
              : 'var(--color-error, #dc2626)';
            const reasonText = (() => {
              if (!d.reason || d.status === 'supported' || d.status === 'skipped') return '';
              const r = d.reason;
              if (/timeout/i.test(r)) return '超时';
              if (/missing credential|no.*token/i.test(r)) return '无 Token';
              if (/no compatible.*endpoint|no.*endpoint candidate/i.test(r)) return '无可用端点';
              if (/no such model|unknown model/i.test(r)) return '模型不存在';
              if (/not found/i.test(r)) return '未找到';
              if (/access denied|forbidden|permission/i.test(r)) return '无权限';
              if (/rate.?limit|too many request/i.test(r)) return '触发频率限制';
              if (/响应延迟/.test(r)) return r;
              return r.length > 60 ? r.slice(0, 57) + '…' : r;
            })();
            addLog(`${s}${lat}  ${d.modelName}${reasonText ? `  —  ${reasonText}` : ''}`, c);
            setTimeout(() => probeLogEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 30);
          } else if (type === 'action') {
            if (d.action === 'disabled') addLog(`  ↳ 已加入站点禁用列表: ${d.modelName}`, 'var(--color-text-muted)');
          } else if (type === 'complete') {
            if (d.unsupported > 0) {
              addLog(`完成：${d.probed} 个模型已探测，${d.unsupported} 个不可用已自动加入禁用列表`, 'var(--color-error, #dc2626)');
              toast.error(`${d.unsupported} 个模型不可用，已自动加入站点禁用列表`);
            } else {
              addLog(`完成：${d.probed} 个模型均可用`, 'var(--color-success, #16a34a)');
              toast.success(`探测完成：${d.probed} 个模型均可用`);
            }
            setTimeout(() => probeLogEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 30);
            // Refresh model lists to reflect probe results
            Promise.all([
              api.getSiteAvailableModels(siteId).then((res: any) => {
                setAvailableModels(Array.isArray(res?.models) ? res.models : []);
              }),
              api.getSiteDisabledModels(siteId).then((res: any) => {
                setDisabledModels(Array.isArray(res?.models) ? res.models : []);
              }),
            ]).catch(() => {}).finally(() => setProbeCompleted(true));
          } else if (type === 'error') {
            addLog(d.message || '探测失败', 'var(--color-error, #dc2626)');
            toast.error(d.message || '探测失败');
            // Refresh model state even on error
            Promise.all([
              api.getSiteAvailableModels(siteId).then((res: any) => {
                setAvailableModels(Array.isArray(res?.models) ? res.models : []);
              }),
              api.getSiteDisabledModels(siteId).then((res: any) => {
                setDisabledModels(Array.isArray(res?.models) ? res.models : []);
              }),
            ]).catch(() => {}).finally(() => setProbeCompleted(true));
          }
        } catch { /* ignore parse errors */ }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          let eventType = 'message';
          let data = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6).trim();
          }
          if (data) handleSseEvent(eventType, data);
        }
      }
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.name === 'AbortError') {
        setProbeLog((prev) => [...prev, { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text: '已手动停止', color: 'var(--color-text-muted)' }]);
        return;
      }
      addLog(eMessage || '探测失败', 'var(--color-error, #dc2626)');
      toast.error(eMessage || '探测失败');
    } finally {
      setProbing(false);
      probeAbortRef.current = null;
    }
  };

  const handleSave = async () => {
    if (!editor) return;
    const parsedGlobalWeight = Number(form.globalWeight);
    if (!Number.isFinite(parsedGlobalWeight) || parsedGlobalWeight <= 0) {
      toast.error('全局权重必须是大于 0 的数字');
      return;
    }
    const serializedCustomHeaders = serializeSiteCustomHeaders(form.customHeaders);
    if (!serializedCustomHeaders.valid) {
      toast.error(serializedCustomHeaders.error || '自定义请求头格式不正确');
      return;
    }
    const serializedApiEndpoints = serializeSiteApiEndpoints(form.apiEndpoints);
    if (!serializedApiEndpoints.valid) {
      toast.error(serializedApiEndpoints.error || 'API 请求地址格式不正确');
      return;
    }

    const payload = {
      name: String(form.name ?? '').trim(),
      url: primarySiteUrlAnalysis.persistedUrl || String(form.url ?? '').trim(),
      platform: normalizedFormPlatform,
      initializationPresetId: selectedInitializationPresetId,
      proxyUrl: String(form.proxyUrl ?? '').trim(),
      apiEndpoints: selectedOauthProvider ? [] : serializedApiEndpoints.apiEndpoints,
      customHeaders: selectedOauthProvider ? '' : serializedCustomHeaders.customHeaders,
      customHeadersOverrideRequestHeaders: selectedOauthProvider ? false : !!form.customHeadersOverrideRequestHeaders,
      paramOverride: selectedOauthProvider ? null : (String(form.paramOverride ?? '').trim() || null),
      globalWeight: Number(parsedGlobalWeight.toFixed(3)),
      protocolProfile: selectedOauthProvider
        ? JSON.stringify({ preferResponses: false, requireCodexClient: false, credentialMode: 'auto' })
        : JSON.stringify(form.protocolProfile),
      postRefreshProbeEnabled: probeEnabled,
      postRefreshProbeModel: String(probeModel ?? '').trim(),
      postRefreshProbeScope: probeScope,
      postRefreshProbeLatencyThresholdMs: Math.max(0, parseInt(probeLatencyThreshold, 10) || 0),
    };
    if (!payload.name || !payload.url) {
      toast.error('请填写站点名称和 URL');
      return;
    }
    if (editor.mode === 'add' && !payload.platform) {
      toast.error('无法自动识别站点类型，请手动选择站点类型后再保存');
      return;
    }

    setSaving(true);
    try {
      const action = buildSiteSaveAction(editor, payload);
      if (action.kind === 'add') {
        const created = await api.addSite(action.payload);
        toast.success(`站点 "${payload.name}" 已添加`);
        const createdUrl = typeof created?.url === 'string' ? created.url.trim() : '';
        if (
          primarySiteUrlAnalysis.action === 'auto_strip_known_api_suffix'
          && createdUrl
        ) {
          toast.info(`已自动规范化主站点 URL 为 ${createdUrl}`);
        }
        const createdSiteId = Number(created?.id) || 0;
        if (createdSiteId > 0) {
          const createdPlatform = typeof created?.platform === 'string' && created.platform.trim()
            ? created.platform.trim()
            : payload.platform;
          const returnedPreset = getSiteInitializationPreset(created?.initializationPresetId);
          const fallbackPreset = selectedInitializationPreset && selectedInitializationPreset.platform === createdPlatform
            ? selectedInitializationPreset
            : null;
          setCreatedSiteForChoice({
            id: createdSiteId,
            name: payload.name,
            platform: createdPlatform,
            initializationPresetId: returnedPreset?.id || fallbackPreset?.id || null,
          });
        }
      } else {
        const updated = await api.updateSite(action.id, action.payload);
        toast.success(`站点 "${payload.name}" 已更新`);
        const updatedUrl = typeof updated?.url === 'string' ? updated.url.trim() : '';
        if (
          primarySiteUrlAnalysis.action === 'auto_strip_known_api_suffix'
          && updatedUrl
        ) {
          toast.info(`已自动规范化主站点 URL 为 ${updatedUrl}`);
        }
      }
      closeEditor();
      await load();
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const updateCustomHeaderRow = (index: number, field: 'key' | 'value', value: string) => {
    setForm((prev) => ({
      ...prev,
      customHeaders: prev.customHeaders.map((item, itemIndex) => (
        itemIndex === index
          ? { ...item, [field]: value }
          : item
      )),
    }));
  };

  const addCustomHeaderRow = () => {
    setForm((prev) => ({
      ...prev,
      customHeaders: [...prev.customHeaders, emptySiteCustomHeader()],
    }));
  };

  const removeCustomHeaderRow = (index: number) => {
    setForm((prev) => {
      const nextHeaders = prev.customHeaders.filter((_, itemIndex) => itemIndex !== index);
      return {
        ...prev,
        customHeaders: nextHeaders.length > 0 ? nextHeaders : [emptySiteCustomHeader()],
      };
    });
  };

  const updateApiEndpointRow = (index: number, patch: Partial<SiteApiEndpointField>) => {
    setForm((prev) => ({
      ...prev,
      apiEndpoints: prev.apiEndpoints.map((item, itemIndex) => (
        itemIndex === index
          ? { ...item, ...patch }
          : item
      )),
    }));
  };

  const addApiEndpointRow = () => {
    setForm((prev) => ({
      ...prev,
      apiEndpoints: [...prev.apiEndpoints, createEmptyApiEndpointRow()],
    }));
  };

  const removeApiEndpointRow = (index: number) => {
    setForm((prev) => {
      const nextEndpoints = prev.apiEndpoints.filter((_, itemIndex) => itemIndex !== index);
      return {
        ...prev,
        apiEndpoints: nextEndpoints.length > 0 ? nextEndpoints : [createEmptyApiEndpointRow()],
      };
    });
  };

  const moveApiEndpointRow = (index: number, direction: 'up' | 'down') => {
    setForm((prev) => {
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.apiEndpoints.length) return prev;
      const nextEndpoints = [...prev.apiEndpoints];
      const [current] = nextEndpoints.splice(index, 1);
      nextEndpoints.splice(targetIndex, 0, current);
      return {
        ...prev,
        apiEndpoints: nextEndpoints,
      };
    });
  };

  /**
   * 从站点页进入账号/API Key 连接创建流程。
   */
  const openSiteConnectionFlow = (input: {
    siteId: number;
    platform?: string | null;
    initializationPresetId?: string | null;
    choice: 'session' | 'apikey';
  }) => {
    const platform = String(input.platform ?? '').toLowerCase().trim();
    const params = buildSiteConnectionSearchParams({
      siteId: input.siteId,
      initializationPresetId: input.initializationPresetId,
    });

    if (input.choice === 'session') {
      if (platform === 'codex' || platform === 'claude' || platform === 'gemini-cli' || platform === 'antigravity') {
        params.set('provider', platform);
        navigate(`/oauth?${params.toString()}`);
        return;
      }
      navigate(`/sites/${input.siteId}?${params.toString()}`, { state: { fromSearch: location.search } });
      return;
    }

    params.set('segment', 'apikey');
    navigate(`/sites/${input.siteId}?${params.toString()}`, { state: { fromSearch: location.search } });
  };

  const handleSiteCreatedChoice = (choice: 'session' | 'apikey' | 'later') => {
    if (!createdSiteForChoice) return;

    if (choice === 'session' || choice === 'apikey') {
      openSiteConnectionFlow({
        siteId: createdSiteForChoice.id,
        platform: createdSiteForChoice.platform,
        initializationPresetId: createdSiteForChoice.initializationPresetId,
        choice,
      });
    }
    // choice === 'later': 不跳转，留在当前页面

    setCreatedSiteForChoice(null);
    closeEditor();
    load();
  };

  const handleDetect = async () => {
    const requestedUrl = String(form.url ?? '').trim();
    const requestedPlatform = normalizedFormPlatform;
    const requestedInitializationPresetId = selectedInitializationPresetId;
    if (!requestedUrl) {
      toast.error('请先输入 URL');
      return;
    }
    const requestedPrimarySiteUrl = analyzePrimarySiteUrl(requestedUrl);
    setDetecting(true);
    try {
      const result = await api.detectSite(requestedUrl);
      if (
        String(latestPrimarySiteUrlRef.current ?? '').trim() !== requestedUrl
        || String(latestPlatformRef.current ?? '').trim() !== requestedPlatform
        || latestInitializationPresetIdRef.current !== requestedInitializationPresetId
      ) {
        return;
      }
      if (result?.platform) {
        const detectedPreset = getSiteInitializationPreset(result?.initializationPresetId);
        setForm((prev) => ({
          ...prev,
          platform: result.platform,
          url: requestedPrimarySiteUrl.action === 'auto_strip_known_api_suffix'
            && typeof result?.url === 'string'
            && String(result.url).trim()
            ? String(result.url).trim()
            : prev.url,
        }));
        setSelectedInitializationPresetId((current) => {
          if (detectedPreset) return detectedPreset.id;
          const activePreset = getSiteInitializationPreset(current);
          if (activePreset && activePreset.platform !== result.platform) return null;
          return current;
        });
        if (
          requestedPrimarySiteUrl.action === 'auto_strip_known_api_suffix'
          && typeof result?.url === 'string'
            && String(result.url).trim()
        ) {
          toast.info(`已自动规范化主站点 URL 为 ${String(result.url).trim()}`);
        }
        toast.success(
          detectedPreset
            ? `检测到平台: ${result.platform}（${detectedPreset.label}）`
            : `检测到平台: ${result.platform}`,
        );
      } else {
        toast.error(result?.error || '无法识别平台类型');
      }
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || '自动检测失败');
    } finally {
      setDetecting(false);
    }
  };

  const handleDelete = async (site: SiteRow) => {
    setDeleteConfirm({ mode: 'single', siteId: site.id, siteName: site.name });
  };

  const handleToggleStatus = async (site: SiteRow) => {
    const nextStatus = site.status === 'disabled' ? 'active' : 'disabled';
    setTogglingSiteId(site.id);
    try {
      await api.updateSite(site.id, { status: nextStatus });
      toast.success(nextStatus === 'disabled' ? `站点 "${site.name}" 已禁用` : `站点 "${site.name}" 已启用`);
      await load();
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || '切换站点状态失败');
    } finally {
      setTogglingSiteId(null);
    }
  };

  /**
   * 从站点列表直接进入 API Key 批量添加入口。
   */
  const handleOpenSiteApiKey = (site: SiteRow) => {
    openSiteConnectionFlow({
      siteId: site.id,
      platform: site.platform,
      initializationPresetId: detectSiteInitializationPreset(site.url, site.platform)?.id || null,
      choice: 'apikey',
    });
  };

  const handleTogglePin = async (site: SiteRow) => {
    const nextPinned = !site.isPinned;
    setPinningSiteId(site.id);
    try {
      if (nextPinned) {
        // 置顶：只改 isPinned，sortOrder 保留（排在最前）
        await api.updateSite(site.id, { isPinned: true });
      } else {
        // 取消置顶：放在非置顶组最前（sortOrder=0），其他非置顶下移
        const unpinUpdates = buildUnpinMoveToFrontUpdates(sites, site.id);
        await Promise.all([
          api.updateSite(site.id, { isPinned: false, sortOrder: 0 }),
          ...unpinUpdates.map((update) => api.updateSite(update.id, { sortOrder: update.sortOrder })),
        ]);
      }
      toast.success(nextPinned ? `站点 "${site.name}" 已置顶` : `站点 "${site.name}" 已取消置顶`);
      await load();
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || '切换置顶失败');
    } finally {
      setPinningSiteId(null);
    }
  };

  const handleMoveCustomOrder = async (site: SiteRow, direction: 'up' | 'down') => {
    const updates = buildCustomReorderUpdates(sites, site.id, direction);
    if (updates.length === 0) return;

    setOrderingSiteId(site.id);
    try {
      await Promise.all(updates.map((update) => api.updateSite(update.id, { sortOrder: update.sortOrder })));
      await load();
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || '更新排序失败');
    } finally {
      setOrderingSiteId(null);
    }
  };

  const toggleSiteDetails = (siteId: number) => {
    setExpandedSiteIds((current) => (
      current.includes(siteId)
        ? current.filter((id) => id !== siteId)
        : [...current, siteId]
    ));
  };

  const confirmDelete = async () => {
    const target = deleteConfirm;
    if (!target?.siteId) return;

    setDeleteConfirm(null);
    setDeleting(target.siteId);
    try {
      await api.deleteSite(target.siteId);
      toast.success(`站点 "${target.siteName || target.siteId}" 已删除`);
      await load();
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || '删除失败');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h2 className="page-title">{tr('站点管理')}</h2>
        <div className="page-actions sites-page-actions">
          {isMobile ? (
            <>
              <button
                type="button"
                onClick={() => setShowMobileTools(true)}
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)' }}
              >
                排序与操作
              </button>
            </>
          ) : (
            <div className="sites-sort-select" style={{ minWidth: 156, position: 'relative', zIndex: 20 }}>
            <ModernSelect
            size="sm"
            value={sortMode}
            onChange={(nextValue) => setSortMode(nextValue as SortMode)}
            options={[
            { value: 'custom', label: '默认排序' },
            { value: 'balance-desc', label: '余额高到低' },
            { value: 'balance-asc', label: '余额低到高' },
            ]}
            placeholder="默认排序"
            />
            </div>
          )}
          <button
            onClick={async () => {
              try {
                const res = await api.triggerCheckinAll();
                toast.success(res?.message || '已触发全部签到');
              } catch (e) {
                const eMessage = e instanceof Error ? e.message : String(e);
                toast.error(eMessage || '签到触发失败');
              }
            }}
            className="btn btn-soft-primary"
          >
            全部签到
          </button>
          <button
            onClick={async () => {
              try {
                const res = await api.refreshAccountHealth();
                if (res?.queued) {
                  toast.info(res.message || '账号状态刷新任务已提交');
                } else {
                  toast.success(res?.message || '账号状态已刷新');
                }
              } catch (e) {
                const eMessage = e instanceof Error ? e.message : String(e);
                toast.error(eMessage || '刷新状态失败');
              }
            }}
            className="btn btn-soft-primary"
          >
            刷新账户状态
          </button>
          <button
            onClick={async () => {
              try {
                const res = await api.syncAllAccountTokens();
                if (res?.queued) {
                  toast.info(res.message || '已开始同步令牌，请稍后查看日志');
                } else {
                  toast.success('同步全部账号令牌完成');
                }
              } catch (e) {
                const eMessage = e instanceof Error ? e.message : String(e);
                toast.error(eMessage || '同步失败');
              }
            }}
            className="btn btn-soft-primary"
          >
            同步全部账号
          </button>
          <button onClick={openAdd} className="btn btn-primary">
            {isAdding ? '取消' : '+ 添加站点'}
          </button>
        </div>
      </div>

      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={showMobileTools}
        onMobileClose={() => setShowMobileTools(false)}
        mobileTitle="站点排序与操作"
        mobileContent={(
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>排序方式</div>
              <ModernSelect
                value={sortMode}
                onChange={(nextValue) => setSortMode(nextValue as SortMode)}
                options={[
                  { value: 'custom', label: '默认排序' },
                  { value: 'balance-desc', label: '余额高到低' },
                  { value: 'balance-asc', label: '余额低到高' },
                ]}
                placeholder="默认排序"
              />
            </div>
          </div>
        )}
      />


      <div className="info-tip" style={{ marginBottom: 12 }}>
        站点倍率 = 全局权重 × 下游 API Key 站点倍率；数值越大越容易被选中。建议 0.5-3，默认 1，长期不超过 5。
      </div>

      <DeleteConfirmModal
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={confirmDelete}
        title="确认删除站点"
        confirmText="确认删除"
        loading={Boolean(deleteConfirm?.siteId && deleting === deleteConfirm.siteId)}
        description={<>确定要删除站点 <strong>{deleteConfirm?.siteName || `#${deleteConfirm?.siteId}`}</strong> 吗？</>}
      />

      {createdSiteForChoice && (
        <SiteCreatedModal
          siteName={createdSiteForChoice.name}
          initialSegment={resolveInitialConnectionSegment(createdSiteForChoice.platform)}
          sessionLabel={resolveSiteCreatedSessionLabel(createdSiteForChoice.platform)}
          oauthOnly={['codex', 'claude', 'gemini-cli', 'antigravity'].includes(String(createdSiteForChoice.platform || '').trim().toLowerCase())}
          onChoice={handleSiteCreatedChoice}
          onClose={() => {
            setCreatedSiteForChoice(null);
            closeEditor();
            load();
          }}
        />
      )}

      {activeEditor && (
        <CenteredModal
          open={Boolean(editor)}
          onClose={closeEditor}
          title={(
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {isEditing ? '编辑站点' : '添加站点'}
            </div>
          )}
          maxWidth={920}
          bodyStyle={{
            maxHeight: isMobile ? '78vh' : '72vh',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
          footer={(
            <>
              <button onClick={closeEditor} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !String(form.name ?? '').trim() || !String(form.url ?? '').trim()}
                className="btn btn-primary"
              >
                {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : (isEditing ? '保存修改' : '保存站点')}
              </button>
            </>
          )}
        >
          <ResponsiveFormGrid>
            <input
              aria-label="站点名称"
              placeholder="站点名称"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              style={formInputStyle}
            />
            {!selectedOauthProvider && (
              <div style={{ display: 'flex', gap: 8, flexDirection: isMobile ? 'column' : 'row' }}>
                <input
                  aria-label="主站点 URL"
                  data-testid="site-primary-url-input"
                  placeholder="准确主站点 URL（面板/登录/签到地址，如 https://nih.cc）"
                  value={form.url}
                  onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
                  onBlur={() => {
                    if (String(form.url ?? '').trim() && !normalizedFormPlatform) {
                      handleDetect();
                    }
                  }}
                  style={{ ...formInputStyle, flex: 1 }}
                />
                <button
                  onClick={handleDetect}
                  disabled={detecting || !String(form.url ?? '').trim()}
                  className="btn btn-ghost"
                  style={{ padding: '10px 14px', minWidth: 96, border: '1px solid var(--color-border)' }}
                >
                  {detecting ? <><span className="spinner spinner-sm" /> 检测中</> : '自动检测'}
                </button>
              </div>
            )}
            <div
              style={{
                border: `1px solid ${normalizedFormPlatform ? 'color-mix(in srgb, var(--color-primary) 28%, var(--color-border))' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-bg)',
                boxShadow: normalizedFormPlatform ? '0 0 0 2px color-mix(in srgb, var(--color-primary) 10%, transparent)' : 'none',
                transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
              }}
            >
              <ModernSelect
                data-testid="site-platform-select"
                value={platformSelectValue}
                onChange={(value) => {
                  const oauthProvider = oauthProviders.find((provider) => provider.platform === value);
                  if (oauthProvider) {
                    setSelectedInitializationPresetId(null);
                    setForm((prev) => ({
                      ...prev,
                      platform: oauthProvider.platform,
                      url: oauthProvider.siteUrl,
                      apiEndpoints: [],
                      customHeaders: [],
                      customHeadersOverrideRequestHeaders: false,
                      paramOverride: '',
                      protocolProfile: { preferResponses: false, requireCodexClient: false, credentialMode: 'auto' },
                    }));
                    return;
                  }
                  if (value.startsWith('preset:')) {
                    const preset = getSiteInitializationPreset(value.slice('preset:'.length));
                    if (!preset) return;
                    setSelectedInitializationPresetId(preset.id);
                    setForm((prev) => {
                      const currentUrl = String(prev.url ?? '').trim();
                      const shouldFillDefaultUrl = !currentUrl
                        || (selectedInitializationPreset?.defaultUrl && currentUrl === selectedInitializationPreset.defaultUrl);
                      return {
                        ...prev,
                        platform: preset.platform,
                        url: shouldFillDefaultUrl && preset.defaultUrl ? preset.defaultUrl : prev.url,
                      };
                    });
                    return;
                  }
                  setForm((prev) => ({
                    ...prev,
                    platform: value,
                    ...(oauthProviders.some((provider) => provider.platform === value)
                      ? {
                        url: oauthProviders.find((provider) => provider.platform === value)?.siteUrl || prev.url,
                        apiEndpoints: [],
                        customHeaders: [],
                        customHeadersOverrideRequestHeaders: false,
                        paramOverride: '',
                        protocolProfile: { preferResponses: false, requireCodexClient: false, credentialMode: 'auto' },
                      }
                      : {}),
                  }));
                  setSelectedInitializationPresetId(null);
                }}
                options={platformOptions}
                placeholder="平台类型（可自动检测）"
              />
            </div>
          </ResponsiveFormGrid>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
            {selectedOauthProvider
              ? '该平台使用 OAuth 授权，官方连接地址已自动配置。'
              : '请填写准确的主站点 URL。这里填写主站点/面板/登录地址，用于登录、签到、面板接口和系统访问令牌管理；不要把 OpenAI/Gemini 请求路径直接填到主站点 URL；如果 API 请求地址和主站点不同，请在下面的 API 请求地址池里填写。'}
          </div>
          {primarySiteUrlAnalysis.action === 'auto_strip_known_api_suffix' && primarySiteUrlAnalysis.persistedUrl ? (
            <div className="alert alert-info animate-scale-in">
              <div className="alert-title">检测到常见 API 路径后缀</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
                保存或自动检测时会将主站点 URL 规范化为 {primarySiteUrlAnalysis.persistedUrl}。
              </div>
            </div>
          ) : null}
          {primarySiteUrlAnalysis.action === 'preserve_api_path' && primarySiteUrlAnalysis.persistedUrl ? (
            <div className="alert alert-warning animate-scale-in">
              <div className="alert-title">请确认主站点 URL</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
                当前 URL 含 /api 路径，将原样保留。请确认这就是准确的主站点 URL；如果这是 API 请求地址，请填到下方的 API 请求地址池。
              </div>
            </div>
          ) : null}
          {primarySiteUrlAnalysis.action === 'preserve_unknown_path' && primarySiteUrlAnalysis.persistedUrl ? (
            <div className="alert alert-warning animate-scale-in">
              <div className="alert-title">请确认主站点 URL</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
                当前 URL 含额外路径，将原样保留。请确认这就是准确的主站点 URL；如果这是 API 请求地址，请填到下方的 API 请求地址池。
              </div>
            </div>
          ) : null}
          <div
            style={{
              display: selectedOauthProvider ? 'none' : 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 12,
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'color-mix(in srgb, var(--color-surface) 82%, transparent)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                API 请求地址池
              </div>
              <button
                type="button"
                onClick={addApiEndpointRow}
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)' }}
              >
                + 添加 API 地址
              </button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
              这里只用于 `/v1/*`、模型发现和 API Key 验证。不填时默认跟随主站点 URL；多条地址会按列表顺序参与轮询，禁用的地址不会参与调度。
            </div>
            {form.apiEndpoints.map((endpoint, index) => (
              <div
                key={endpoint.draftId || `site-api-endpoint-draft-${index}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: 10,
                  border: '1px solid var(--color-border-light)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-bg)',
                }}
              >
                <div style={{ display: 'flex', gap: 8, flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center' }}>
                  <input
                    placeholder="API 请求地址（如 https://api.nih.cc）"
                    value={endpoint.url}
                    onChange={(e) => updateApiEndpointRow(index, { url: e.target.value })}
                    style={{ ...formInputStyle, flex: 1, fontFamily: 'var(--font-mono)' }}
                  />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    <input
                      type="checkbox"
                      checked={endpoint.enabled !== false}
                      onChange={(e) => updateApiEndpointRow(index, { enabled: e.target.checked })}
                    />
                    启用
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--color-text-muted)' }}>
                    <span>顺序 #{index + 1}</span>
                    {endpoint.cooldownUntil ? <span>冷却至 {formatDateTimeLocal(endpoint.cooldownUntil)}</span> : null}
                    {endpoint.lastFailureReason ? <span>最近失败: {endpoint.lastFailureReason}</span> : null}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => moveApiEndpointRow(index, 'up')}
                      disabled={index === 0}
                      className="btn btn-link btn-link-muted"
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      onClick={() => moveApiEndpointRow(index, 'down')}
                      disabled={index >= form.apiEndpoints.length - 1}
                      className="btn btn-link btn-link-muted"
                    >
                      下移
                    </button>
                    <button
                      type="button"
                      onClick={() => removeApiEndpointRow(index)}
                      className="btn btn-link btn-link-danger"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              display: selectedOauthProvider ? 'none' : 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 12,
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'color-mix(in srgb, var(--color-surface) 82%, transparent)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                站点自定义请求头
              </div>
              <button
                type="button"
                onClick={addCustomHeaderRow}
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)' }}
              >
                + 添加请求头
              </button>
            </div>
            {form.customHeaders.map((header, index) => (
              <div
                key={`custom-header-${index}`}
                style={{
                  display: 'flex',
                  gap: 8,
                  flexDirection: isMobile ? 'column' : 'row',
                  alignItems: isMobile ? 'stretch' : 'center',
                }}
              >
                <input
                  aria-label={`自定义请求头 ${index + 1} 名称`}
                  placeholder="Header 名称"
                  value={header.key}
                  onChange={(e) => updateCustomHeaderRow(index, 'key', e.target.value)}
                  style={{ ...formInputStyle, flex: 1, fontFamily: 'var(--font-mono)' }}
                />
                <input
                  aria-label={`自定义请求头 ${index + 1} 值`}
                  placeholder="Header 值"
                  value={header.value}
                  onChange={(e) => updateCustomHeaderRow(index, 'value', e.target.value)}
                  style={{ ...formInputStyle, flex: 1, fontFamily: 'var(--font-mono)' }}
                />
                <button
                  type="button"
                  onClick={() => removeCustomHeaderRow(index)}
                  className="btn btn-link btn-link-danger"
                  style={isMobile ? { alignSelf: 'flex-end' } : undefined}
                >
                  删除
                </button>
              </div>
            ))}
            <label style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '10px 12px',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-bg)',
              color: 'var(--color-text-primary)',
              fontSize: 13,
            }}>
              <input
                type="checkbox"
                checked={isCodexCompatibilityModeEnabled(form)}
                onChange={(e) => {
                  setForm((prev) => applyCodexCompatibilityMode(prev, e.target.checked));
                }}
                style={{ marginTop: 2 }}
              />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>Codex 兼容模式</span>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                  用于只允许 Codex 客户端访问的站点。开启后自动配置 Responses 协议、客户端指纹和请求头，无需手动设置。
                </span>
              </span>
            </label>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
              按 key/value 逐条填写。整行留空会自动忽略；同名请求头不允许重复。
            </div>
            {isEditing && (
              <div style={{ marginTop: 16, padding: '14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>禁用模型管理</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
                  在此站点禁用指定模型后，路由重建时将不为该站点的这些模型创建通道。勾选表示禁用该模型。
                </div>
                {disabledModelsLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    <span className="spinner spinner-sm" /> 加载中...
                  </div>
                ) : (
                  <>
                    {/* Search and brand group controls */}
                    {brandGroups.length > 0 ? (
                      <div style={{ marginBottom: 10 }}>
                        <input
                          placeholder="搜索模型名称..."
                          value={disabledModelSearch}
                          onChange={(e) => setDisabledModelSearch(e.target.value)}
                          style={{
                            width: '100%', padding: '6px 10px', border: '1px solid var(--color-border)',
                            borderRadius: 'var(--radius-sm)', fontSize: 12, outline: 'none',
                            background: 'var(--color-bg)', color: 'var(--color-text-primary)', marginBottom: 8,
                          }}
                        />
                        {/* Brand group quick actions */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: '24px' }}>按品牌全选：</span>
                          {brandGroups.map(([brandName, models]) => {
                            const allDisabled = models.every((m) => disabledModelSet.has(m));
                            return (
                              <button
                                key={brandName}
                                type="button"
                                onClick={() => {
                                  if (allDisabled) {
                                    const removeSet = new Set(models);
                                    setDisabledModels((prev) => prev.filter((m) => !removeSet.has(m)));
                                  } else {
                                    setDisabledModels((prev) => Array.from(new Set([...prev, ...models])));
                                  }
                                }}
                                className={`badge ${allDisabled ? 'badge-warning' : 'badge-muted'}`}
                                style={{ fontSize: 10, cursor: 'pointer', border: 'none', padding: '3px 8px' }}
                                data-tooltip={allDisabled ? `取消禁用全部 ${brandName} 模型 (${models.length})` : `禁用全部 ${brandName} 模型 (${models.length})`}
                              >
                                {brandName} ({models.length})
                              </button>
                            );
                          })}
                        </div>
                        {/* Checkbox list */}
                        <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '4px 0' }}>
                          {filteredBrandGroups.length === 0 ? (
                            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--color-text-muted)' }}>无匹配模型</div>
                          ) : filteredBrandGroups.map(([brandName, models]) => (
                            <div key={brandName}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', padding: '4px 12px', background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border-light)' }}>
                                {brandName} ({models.length})
                              </div>
                              {models.map((model) => {
                                const isDisabled = disabledModelSet.has(model);
                                return (
                                  <label
                                    key={model}
                                    style={{
                                      display: 'flex', alignItems: 'center', gap: 8, padding: '3px 12px',
                                      fontSize: 12, cursor: 'pointer', lineHeight: 1.6,
                                      background: isDisabled ? 'color-mix(in srgb, var(--color-warning) 8%, transparent)' : 'transparent',
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isDisabled}
                                      onChange={(e) => {
                                        if (e.target.checked) {
                                          setDisabledModels((prev) => Array.from(new Set([...prev, model])));
                                        } else {
                                          setDisabledModels((prev) => prev.filter((m) => m !== model));
                                        }
                                      }}
                                    />
                                    <span style={{ color: isDisabled ? 'var(--color-warning)' : 'var(--color-text-primary)' }}>
                                      {model}
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
                        暂无已发现模型，仍可手动添加需要屏蔽的模型名。
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 8, marginTop: 10, marginBottom: 10 }}>
                      <input
                        placeholder="输入模型名称，如 gpt-4o"
                        value={disabledModelInput}
                        onChange={(e) => setDisabledModelInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddDisabledModel();
                          }
                        }}
                        style={{
                          flex: 1, padding: '8px 12px', border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-sm)', fontSize: 12, outline: 'none',
                          background: 'var(--color-bg)', color: 'var(--color-text-primary)',
                        }}
                      />
                      <button
                        onClick={handleAddDisabledModel}
                        className="btn btn-ghost"
                        style={{ padding: '8px 14px', fontSize: 12, border: '1px solid var(--color-border)' }}
                      >
                        添加模型
                      </button>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                      <button
                        onClick={handleSaveDisabledModels}
                        disabled={disabledModelsSaving}
                        className="btn btn-primary"
                        style={{ fontSize: 12, padding: '6px 16px' }}
                      >
                        {disabledModelsSaving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存禁用列表'}
                      </button>
                      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                        已禁用 {disabledModels.length} 个模型
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div style={{ display: selectedOauthProvider ? 'none' : 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            <div style={{ padding: 14, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'color-mix(in srgb, var(--color-surface) 82%, transparent)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>请求体参数覆盖（paramOverride）</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5, marginBottom: 8 }}>
                JSON 对象，转发请求时合并进上游请求体（顶层字段覆盖客户端传参）。例如：
                <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{'{"max_tokens": 64, "temperature": 0}'}</code>。留空表示不覆盖。
              </div>
              <textarea
                placeholder='{"max_tokens": 64, "temperature": 0}'
                value={form.paramOverride}
                onChange={(e) => setForm((prev) => ({ ...prev, paramOverride: e.target.value }))}
                rows={2}
                style={{
                  ...formInputStyle,
                  width: '100%',
                  fontFamily: 'var(--font-mono)',
                  resize: 'vertical',
                  minHeight: 52,
                }}
              />
            </div>
            <div style={{ padding: '14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'color-mix(in srgb, var(--color-surface) 82%, transparent)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>凭证提示</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
                添加账号时的凭证验证策略提示
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(['auto', 'api_key', 'session'] as const).map((mode) => (
                  <label
                    key={mode}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      cursor: 'pointer',
                      fontSize: 13,
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    <input
                      type="radio"
                      name="credentialMode"
                      value={mode}
                      checked={form.protocolProfile.credentialMode === mode}
                      onChange={(e) => setForm((prev) => ({
                        ...prev,
                        protocolProfile: { ...prev.protocolProfile, credentialMode: e.target.value },
                      }))}
                      style={{ accentColor: 'var(--color-primary)', width: 14, height: 14 }}
                    />
                    {mode === 'auto' ? '自动' : mode === 'api_key' ? 'API Key（sk-...）' : 'Session Cookie'}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {isEditing && (
            <div style={{ marginTop: 16, padding: '14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>刷新后自动测试请求</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
                开启后，每次自动获取模型列表成功后，会对指定模型发送一次真实测试请求。若判定不可用，自动加入站点禁用列表并重建路由。
              </div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={probeEnabled}
                  onChange={(e) => setProbeEnabled(e.target.checked)}
                  style={{ width: 15, height: 15, marginTop: 2, flexShrink: 0 }}
                />
                <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>开启刷新后自动探测</span>
              </label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', opacity: probeEnabled ? 1 : 0.5 }}>
                {([['single', '指定模型'] , ['all', '全部模型']] as const).map(([val, label]) => (
                  <label
                    key={val}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      cursor: probeEnabled ? 'pointer' : 'default',
                      padding: '5px 12px', borderRadius: 'var(--radius-sm)', fontSize: 12,
                      border: `1px solid ${probeScope === val ? 'var(--color-primary)' : 'var(--color-border-light)'}`,
                      background: probeScope === val ? 'color-mix(in srgb, var(--color-primary) 8%, transparent)' : 'transparent',
                      userSelect: 'none',
                    }}
                  >
                    <input
                      type="radio"
                      name="siteProbeScope"
                      value={val}
                      checked={probeScope === val}
                      onChange={() => setProbeScope(val)}
                      disabled={!probeEnabled}
                      style={{ accentColor: 'var(--color-primary)', width: 13, height: 13 }}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {probeScope === 'single' && (
                <input
                  type="text"
                  placeholder="探测模型名（留空则自动取第一个发现的模型）"
                  value={probeModel}
                  onChange={(e) => setProbeModel(e.target.value)}
                  disabled={!probeEnabled}
                  style={{
                    width: '100%', padding: '6px 10px', border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)', fontSize: 12, outline: 'none',
                    background: 'var(--color-bg)', color: 'var(--color-text-primary)',
                    marginBottom: 10, opacity: probeEnabled ? 1 : 0.5,
                    fontFamily: 'var(--font-mono)',
                  }}
                />
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>延迟阈值</span>
                <input
                  type="number"
                  min="0"
                  step="500"
                  placeholder="0"
                  value={probeLatencyThreshold}
                  onChange={(e) => setProbeLatencyThreshold(e.target.value)}
                  style={{
                    width: 90, padding: '5px 8px', border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)', fontSize: 12, outline: 'none',
                    background: 'var(--color-bg)', color: 'var(--color-text-primary)',
                  }}
                />
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>ms（响应超过该时间则自动禁用，0=不限）</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button
                  onClick={() => void handleSaveProbeSettings()}
                  disabled={probeSaving || probing}
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: '6px 16px', border: '1px solid var(--color-border)' }}
                >
                  {probeSaving ? <><span className="spinner spinner-sm" /> 保存中...</> : '保存探测设置'}
                </button>
                <button
                  onClick={() => void handleProbeNow()}
                  disabled={probing || probeSaving}
                  className="btn btn-primary"
                  style={{ fontSize: 12, padding: '6px 16px' }}
                >
                  {probing ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 探测中...</> : '立即探测'}
                </button>
                {probing && (
                  <button
                    onClick={() => { probeAbortRef.current?.abort(); }}
                    className="btn btn-ghost"
                    style={{ fontSize: 12, padding: '6px 16px', border: '1px solid var(--color-error, #dc2626)', color: 'var(--color-error, #dc2626)' }}
                  >
                    停止
                  </button>
                )}
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                  {probeEnabled ? '实际探测超时复用「批量测活超时」设置' : '当前已关闭'}
                </span>
              </div>
              {probeLog.length > 0 && (
                <div style={{
                  marginTop: 10, padding: '8px 10px',
                  background: 'var(--color-bg)', border: '1px solid var(--color-border-light)',
                  borderRadius: 'var(--radius-sm)', fontSize: 11,
                  fontFamily: 'var(--font-mono)', maxHeight: 200, overflowY: 'auto',
                  lineHeight: 1.8,
                }}>
                  {probeLog.map((entry, i) => (
                    <div key={i} style={{ color: entry.color || 'var(--color-text-secondary)' }}>
                      <span style={{ color: 'var(--color-text-muted)', marginRight: 8 }}>{entry.time}</span>
                      {entry.text}
                    </div>
                  ))}
                  <div ref={probeLogEndRef} />
                </div>
              )}
              {probeCompleted && brandGroups.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--color-text-secondary)' }}>
                    探测后模型状态
                    <span style={{ fontWeight: 400, marginLeft: 6, color: 'var(--color-text-muted)' }}>
                      — 可用 {availableModels.filter((m) => !disabledModelSet.has(m)).length} 个，已禁用 {disabledModels.length} 个
                    </span>
                  </div>
                  <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '4px 0' }}>
                    {brandGroups.map(([brandName, models]) => (
                      <div key={brandName}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', padding: '4px 12px', background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border-light)' }}>
                          {brandName} ({models.length})
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px 12px' }}>
                          {models.map((model) => {
                            const isDisabled = disabledModelSet.has(model);
                            return (
                              <span
                                key={model}
                                style={{
                                  fontSize: 11, padding: '2px 7px', borderRadius: 10,
                                  fontFamily: 'var(--font-mono)',
                                  background: isDisabled
                                    ? 'color-mix(in srgb, var(--color-error, #dc2626) 12%, transparent)'
                                    : 'color-mix(in srgb, var(--color-success, #16a34a) 12%, transparent)',
                                  color: isDisabled ? 'var(--color-error, #dc2626)' : 'var(--color-success, #16a34a)',
                                  border: `1px solid ${isDisabled ? 'color-mix(in srgb, var(--color-error, #dc2626) 30%, transparent)' : 'color-mix(in srgb, var(--color-success, #16a34a) 30%, transparent)'}`,
                                }}
                              >
                                {model}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <ResponsiveFormGrid>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                placeholder="站点代理（可选，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）"
                value={form.proxyUrl}
                onChange={(e) => setForm((prev) => ({ ...prev, proxyUrl: e.target.value }))}
                style={formInputStyle}
              />
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                HTTP/SOCKS 代理地址，填写后该站点的出站请求将通过此代理。留空则直连。
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                placeholder="站点全局权重（默认 1）"
                value={form.globalWeight}
                onChange={(e) => setForm((prev) => ({ ...prev, globalWeight: e.target.value }))}
                style={formInputStyle}
              />
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                越大越容易被路由选中。建议 0.5-3，默认 1。
              </div>
            </div>
          </ResponsiveFormGrid>
        </CenteredModal>
      )}

      <div className="card" style={{ overflowX: 'auto', paddingBottom: 12 }}>
        {sites.length > 0 ? (
          isMobile ? (
            <div className="mobile-card-list">
              {pagedSites.map((site) => {
                const isExpanded = expandedSiteIds.includes(site.id);
                return (
                  <MobileCard
                    key={site.id}
                    title={(
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span>{site.name || '-'}</span>
                        {site.url ? (
                          <a
                            href={site.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="sites-url-link"
                            style={{
                              fontSize: 12,
                              fontFamily: 'var(--font-mono)',
                              color: 'var(--color-primary)',
                              textDecoration: 'underline',
                              wordBreak: 'break-all',
                            }}
                          >
                            {site.url}
                          </a>
                        ) : null}
                      </div>
                    )}
                    footerActions={(
                      <>
                        <button
                          type="button"
                          onClick={() => navigate(`/sites/${site.id}`, { state: { fromSearch: location.search } })}
                          className="btn btn-link btn-link-primary"
                        >
                          详情
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleSiteDetails(site.id)}
                          className="btn btn-link"
                        >
                          {isExpanded ? '收起' : '展开'}
                        </button>
                        <button
                          onClick={() => handleOpenSiteApiKey(site)}
                          className="btn btn-link btn-link-primary"
                        >
                          添加 Key
                        </button>
                        <button
                          onClick={() => openEdit(site)}
                          className="btn btn-link btn-link-primary"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => handleToggleStatus(site)}
                          disabled={togglingSiteId === site.id}
                          className={`btn btn-link ${site.status === 'disabled' ? 'btn-link-primary' : 'btn-link-warning'}`}
                        >
                          {togglingSiteId === site.id ? <span className="spinner spinner-sm" /> : (site.status === 'disabled' ? '启用' : '禁用')}
                        </button>
                      </>
                    )}
                  >
                    <MobileField
                      label="状态"
                      value={(
                        <span className={`badge ${site.status === 'disabled' ? 'badge-muted' : 'badge-success'}`} style={{ fontSize: 11 }}>
                          {site.status === 'disabled' ? '禁用' : '启用'}
                        </span>
                      )}
                    />
                    <MobileField
                      label="平台"
                      value={(
                        <span className={`badge ${platformColors[site.platform || ''] || 'badge-muted'}`} style={{ fontSize: 11 }}>
                          {site.platform || '-'}
                        </span>
                      )}
                    />
                    <MobileField
                      label="余额"
                      value={(
                        <SiteBalanceDisplay
                          balance={site.totalBalance}
                          todayReward={site.todayReward}
                          todaySpend={site.todaySpend}
                          summary={site.subscriptionSummary}
                          align="end"
                        />
                      )}
                    />
                    <MobileField
                      label="健康"
                      value={(
                        <span
                          className={`badge ${site.healthState?.state === 'healthy'
                            ? 'badge-success'
                            : site.healthState?.state === 'unhealthy'
                              ? 'badge-danger'
                              : site.healthState?.state === 'degraded'
                                ? 'badge-warning'
                                : 'badge-muted'}`}
                          title={site.healthState?.reason || '尚未检测'}
                          style={{ fontSize: 11 }}
                        >
                          {site.healthState?.state === 'healthy'
                            ? '正常'
                            : site.healthState?.state === 'unhealthy'
                              ? '异常'
                              : site.healthState?.state === 'degraded'
                                ? '降级'
                                : site.healthState?.state === 'disabled'
                                  ? '禁用'
                                  : '未检测'}
                        </span>
                      )}
                    />
                    <MobileField label="权重" value={(site.globalWeight || 1).toFixed(2)} />
                    <MobileField
                      label="连接"
                      value={(() => {
                        const stats = site.connectionStats;
                        if (!stats) return '-';
                        const parts = [];
                        if (stats.sessions > 0) parts.push(`👤${stats.sessions}`);
                        if (stats.apiKeys > 0) parts.push(`🔑${stats.apiKeys}`);
                        if (stats.tokens > 0) parts.push(`🎫${stats.tokens}`);
                        if (stats.oauth > 0) parts.push(`🔓${stats.oauth}`);
                        return parts.length > 0 ? parts.join(' ') : '-';
                      })()}
                    />
                    {isExpanded ? (
                      <div className="mobile-card-extra">
                        <MobileField
                          label="主站点 URL"
                          stacked
                          value={site.url ? (
                            <a
                              href={site.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="sites-url-link"
                              style={{
                                fontSize: 12,
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--color-primary)',
                                textDecoration: 'underline',
                                wordBreak: 'break-all',
                              }}
                            >
                              {site.url}
                            </a>
                          ) : '-'}
                        />
                        {getConfiguredSiteApiEndpoints(site).length > 0 ? (
                          <MobileField
                            label="API 请求地址"
                            stacked
                            value={(
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {getConfiguredSiteApiEndpoints(site).map((endpoint, endpointIndex) => (
                                  <span
                                    key={`mobile-site-endpoint-${site.id}-${endpoint.id ?? endpointIndex}`}
                                    style={{
                                      fontSize: 11,
                                      fontFamily: 'var(--font-mono)',
                                      color: endpoint.enabled === false ? 'var(--color-text-muted)' : 'var(--color-text-secondary)',
                                      wordBreak: 'break-all',
                                    }}
                                  >
                                    {endpoint.url}
                                    {endpoint.enabled === false ? '（已禁用）' : ''}
                                  </span>
                                ))}
                              </div>
                            )}
                          />
                        ) : null}
                        <MobileField
                          label="创建时间"
                          value={formatDateTimeLocal(site.createdAt)}
                        />
                        <div className="mobile-card-actions">
                          <button
                            onClick={() => handleTogglePin(site)}
                            disabled={pinningSiteId === site.id}
                            className={`btn btn-link ${site.isPinned ? 'btn-link-warning' : 'btn-link-primary'}`}
                          >
                            {pinningSiteId === site.id ? <span className="spinner spinner-sm" /> : (site.isPinned ? '取消置顶' : '置顶')}
                          </button>
                          {sortMode === 'custom' && (
                            <>
                              <button
                                onClick={() => handleMoveCustomOrder(site, 'up')}
                                disabled={orderingSiteId === site.id}
                                className="btn btn-link btn-link-muted"
                              >
                                ↑ 上移
                              </button>
                              <button
                                onClick={() => handleMoveCustomOrder(site, 'down')}
                                disabled={orderingSiteId === site.id}
                                className="btn btn-link btn-link-muted"
                              >
                                ↓ 下移
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => handleDelete(site)}
                            disabled={deleting === site.id}
                            className="btn btn-link btn-link-danger"
                          >
                            {deleting === site.id ? <span className="spinner spinner-sm" /> : null}
                            删除
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </MobileCard>
                );
              })}
            </div>
          ) : (
            <div className="sites-desktop-table-wrap" ref={sitesTableWrapRef}>
            <table className="data-table sites-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>创建时间</th>
                  <th>余额</th>
                  <th>状态</th>
                  <th>健康</th>
                  <th>权重</th>
                  <th>平台</th>
                  <th>连接</th>
                  <th className="sites-actions-col">操作</th>
                </tr>
              </thead>
              <tbody>
                {pagedSites.map((site, i) => (
                  <tr
                    key={site.id}
                    data-testid={`site-row-${site.id}`}
                    ref={(node) => {
                      if (node) rowRefs.current.set(site.id, node);
                      else rowRefs.current.delete(site.id);
                    }}
                    className={`animate-slide-up stagger-${Math.min(i + 1, 5)} ${highlightSiteId === site.id ? 'row-focus-highlight' : ''}`.trim()}
                  >
                    <td className="sites-name-col" style={{ fontWeight: 600 }}>
                      <div className="sites-name-cell">
                        <div className="sites-name-primary">
                          <a
                            href={site.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="sites-name-link"
                            title={site.name}
                          >
                            {site.name}
                          </a>
                        </div>
                        {(() => {
                          const endpoints = getConfiguredSiteApiEndpoints(site);
                          const enabledCount = endpoints.filter((item) => item.enabled !== false).length;
                          // 默认态（无独立地址 / 单地址全启用）无需徽章；仅在有多地址或存在禁用时提示
                          if (endpoints.length === 0 || (endpoints.length === 1 && enabledCount === 1)) return null;
                          const allEnabled = enabledCount === endpoints.length;
                          return (
                            <span className={`badge ${allEnabled ? 'badge-info' : 'badge-warning'}`} style={{ fontSize: 11 }}>
                              API 地址 {enabledCount}/{endpoints.length} 条启用
                            </span>
                          );
                        })()}
                      </div>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--color-text-muted)', textDecoration: 'underline' }}
                      >
                        {formatDateTimeLocal(site.createdAt)}
                      </a>
                    </td>
                    <td className="site-balance-cell">
                      <SiteBalanceDisplay
                        balance={site.totalBalance}
                        todayReward={site.todayReward}
                        todaySpend={site.todaySpend}
                        summary={site.subscriptionSummary}
                      />
                    </td>
                    <td>
                      <span className={`badge ${site.status === 'disabled' ? 'badge-muted' : 'badge-success'}`} style={{ fontSize: 11 }}>
                        {site.status === 'disabled' ? '禁用' : '启用'}
                      </span>
                    </td>
                    <td title={site.healthState?.reason || '尚未检测'}>
                      <span
                        className={`badge ${site.healthState?.state === 'healthy'
                          ? 'badge-success'
                          : site.healthState?.state === 'unhealthy'
                            ? 'badge-danger'
                            : site.healthState?.state === 'degraded'
                              ? 'badge-warning'
                              : 'badge-muted'}`}
                        style={{ fontSize: 11 }}
                      >
                        {site.healthState?.state === 'healthy'
                          ? '正常'
                          : site.healthState?.state === 'unhealthy'
                            ? '异常'
                            : site.healthState?.state === 'degraded'
                              ? '降级'
                              : site.healthState?.state === 'disabled'
                                ? '禁用'
                                : '未检测'}
                      </span>
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {(site.globalWeight || 1).toFixed(2)}
                    </td>
                    <td>
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ textDecoration: 'none' }}
                      >
                        <span className={`badge ${platformColors[site.platform || ''] || 'badge-muted'}`}>
                          {site.platform || '-'}
                        </span>
                      </a>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--color-text-secondary)', flexWrap: 'wrap', justifyContent: 'center' }}>
                        {site.connectionStats && site.connectionStats.sessions > 0 && (
                          <span title="Session 账号">👤{site.connectionStats.sessions}</span>
                        )}
                        {site.connectionStats && site.connectionStats.apiKeys > 0 && (
                          <span title="API Key">🔑{site.connectionStats.apiKeys}</span>
                        )}
                        {site.connectionStats && site.connectionStats.tokens > 0 && (
                          <span title="令牌">🎫{site.connectionStats.tokens}</span>
                        )}
                        {site.connectionStats && site.connectionStats.oauth > 0 && (
                          <span title="OAuth">🔓{site.connectionStats.oauth}</span>
                        )}
                        {(!site.connectionStats || (site.connectionStats.sessions === 0 && site.connectionStats.apiKeys === 0 && site.connectionStats.tokens === 0 && site.connectionStats.oauth === 0)) && (
                          <span style={{ color: 'var(--color-text-muted)' }}>-</span>
                        )}
                      </div>
                    </td>
                    <td className="sites-actions-cell">
                      <div className="sites-row-actions">
                        <button
                          onClick={() => navigate(`/sites/${site.id}`, { state: { fromSearch: location.search } })}
                          className="btn btn-link btn-link-primary"
                        >
                          详情
                        </button>
                        <button
                          onClick={() => handleTogglePin(site)}
                          disabled={pinningSiteId === site.id}
                          className={`btn btn-link ${site.isPinned ? 'btn-link-warning' : 'btn-link-primary'}`}
                        >
                          {pinningSiteId === site.id ? <span className="spinner spinner-sm" /> : (site.isPinned ? '取消置顶' : '置顶')}
                        </button>
                        {sortMode === 'custom' && (
                          <>
                            <button
                              onClick={() => handleMoveCustomOrder(site, 'up')}
                              disabled={orderingSiteId === site.id}
                              className="btn btn-link btn-link-muted"
                            >
                              ↑
                            </button>
                            <button
                              onClick={() => handleMoveCustomOrder(site, 'down')}
                              disabled={orderingSiteId === site.id}
                              className="btn btn-link btn-link-muted"
                            >
                              ↓
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => handleOpenSiteApiKey(site)}
                          className="btn btn-link btn-link-primary"
                        >
                          添加 Key
                        </button>
                        <button
                          onClick={() => openEdit(site)}
                          className="btn btn-link btn-link-primary"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => handleToggleStatus(site)}
                          disabled={togglingSiteId === site.id}
                          className={`btn btn-link ${site.status === 'disabled' ? 'btn-link-primary' : 'btn-link-warning'}`}
                        >
                          {togglingSiteId === site.id ? <span className="spinner spinner-sm" /> : (site.status === 'disabled' ? '启用' : '禁用')}
                        </button>
                        <button
                          onClick={() => handleDelete(site)}
                          disabled={deleting === site.id}
                          className="btn btn-link btn-link-danger"
                        >
                          {deleting === site.id ? <span className="spinner spinner-sm" /> : null}
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )
        ) : (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"
              />
            </svg>
            <div className="empty-state-title">暂无站点</div>
            <div className="empty-state-desc">点击“+ 添加站点”开始使用。</div>
          </div>
        )}
        <PaginationControls
          page={safePage}
          totalPages={totalPages}
          onPageChange={(next) => {
            setPage(next);
            const targetPage = typeof next === 'function' ? next(safePage) : next;
            const params = new URLSearchParams(location.search);
            params.set('page', String(targetPage));
            navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
          }}
          visible={showSitePagination}
        />
      </div>
    </div>
  );
}
