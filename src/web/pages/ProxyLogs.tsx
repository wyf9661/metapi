import React, {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  api,
  type RuntimeSettingsPayload,
  type ProxyDebugTraceDetail,
  type ProxyDebugTraceListItem,
  type ProxyLogBillingDetails,
  type ProxyLogClientOption,
  type ProxyLogDetail,
  type ProxyLogListItem,
  type ProxyLogsSummary,
  type ProxyLogStatusFilter,
  type ProxyLogUsageSource,
} from "../api.js";
import { useToast } from "../components/Toast.js";
import { ModelBadge } from "../components/BrandIcon.js";
import CenteredModal from "../components/CenteredModal.js";
import MobileDrawer from "../components/MobileDrawer.js";
import ResponsiveFormGrid from "../components/ResponsiveFormGrid.js";
import SiteBadgeLink from "../components/SiteBadgeLink.js";
import { MobileCard, MobileField } from "../components/MobileCard.js";
import ResponsiveFilterPanel from "../components/ResponsiveFilterPanel.js";
import { useIsMobile } from "../components/useIsMobile.js";
import { formatDateTimeLocal } from "./helpers/checkinLogTime.js";
import ModernSelect from "../components/ModernSelect.js";
import { parseProxyLogPathMeta } from "./helpers/proxyLogPathMeta.js";
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PROXY_DEBUG_SETTINGS,
  DEBUG_REFRESH_INTERVAL_MS,
  DEBUG_TRACE_PAGE_SIZE,
  EMPTY_SUMMARY,
  PAGE_SIZES,
  TRACE_TABLE_LIMIT,
  buildBillingProcessLines,
  buildProxyDebugSettingsPayload,
  buildProxyLogsRouteSearch,
  firstByteBgColor,
  firstByteColor,
  formatBillingDetailSummary,
  formatCompactNumber,
  formatDateTimeInputValue,
  formatFirstByteLabel,
  formatLatency,
  formatProxyDebugCaptureSummary,
  formatProxyDebugTargetSummary,
  formatProxyLogClientFamilyLabel,
  formatProxyLogTokenValue,
  formatProxyLogUsageSource,
  formatStreamModeLabel,
  latencyBgColor,
  latencyColor,
  normalizeProxyDebugSettings,
  parseStoredDebugPreview,
  persistDebugTracePanelExpanded,
  readProxyLogsRouteState,
  readStoredDebugTracePanelExpanded,
  renderDownstreamKeySummary,
  resolveProxyLogClientDisplay,
  stringifyStoredDebugValue,
  toApiTimeBoundary,
  type ProxyDebugSettingsState,
  type ProxyLogRenderItem,
  type StoredDebugPreviewPayload,
} from "./helpers/proxyLogsHelpers.js";
import {
  CompactSummaryMetric,
  DetailDisclosureCard,
  copyTextToClipboard,
  debugCheckboxRowStyle,
  debugCodeBlockStyle,
  detailExpandableCardStyle,
  detailExpandableSummaryStyle,
  detailInfoGridStyle,
  detailInfoItemStyle,
  detailInfoLabelStyle,
  detailInfoValueStyle,
  detailSectionTitleStyle,
  formInputStyle,
  formSectionLabelStyle,
  formSectionStyle,
  renderProxyLogClientCell,
  StreamModeIcon,
} from "./helpers/proxyLogsUi.js";
import { tr } from "../i18n.js";

type ProxyLogDetailState = {
  loading: boolean;
  data?: ProxyLogDetail;
  error?: string;
};

type ProxyLogSiteFilterOption = {
  id: number;
  name: string;
  status: string | null;
};

type ProxyDebugTraceDetailState = {
  loading: boolean;
  data?: ProxyDebugTraceDetail;
  error?: string;
};

type ProxyDebugTraceAttempt = ProxyDebugTraceDetail["attempts"][number];
export default function ProxyLogs() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialRouteState = useMemo(
    () => readProxyLogsRouteState(location.search),
    [location.search],
  );
  const [logs, setLogs] = useState<ProxyLogListItem[]>([]);
  const [summary, setSummary] = useState<ProxyLogsSummary>(EMPTY_SUMMARY);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<ProxyLogStatusFilter>(
    initialRouteState.status,
  );
  const [searchInput, setSearchInput] = useState(initialRouteState.search);
  const deferredSearchInput = useDeferredValue(searchInput.trim());
  const [clientFilter, setClientFilter] = useState(initialRouteState.client);
  const [siteFilter, setSiteFilter] = useState<number | null>(
    initialRouteState.siteId,
  );
  const [modelFilter, setModelFilter] = useState(initialRouteState.model);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [fromInput, setFromInput] = useState(initialRouteState.from);
  const [toInput, setToInput] = useState(initialRouteState.to);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [page, setPage] = useState(initialRouteState.page);
  const [pageSize, setPageSize] = useState(initialRouteState.pageSize);
  const [detailById, setDetailById] = useState<
    Record<number, ProxyLogDetailState>
  >({});
  const [showFilters, setShowFilters] = useState(false);
  const [sites, setSites] = useState<
    Array<{ id: number; name: string; status?: string | null }>
  >([]);
  const [clientOptions, setClientOptions] = useState<ProxyLogClientOption[]>(
    [],
  );
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [showDebugSettingsModal, setShowDebugSettingsModal] = useState(false);
  const [debugPanelLoading, setDebugPanelLoading] = useState(false);
  const [debugPanelSaving, setDebugPanelSaving] = useState(false);
  const [debugTracePanelExpanded, setDebugTracePanelExpanded] = useState(() =>
    readStoredDebugTracePanelExpanded(),
  );
  const [debugSettings, setDebugSettings] = useState<ProxyDebugSettingsState>(
    DEFAULT_PROXY_DEBUG_SETTINGS,
  );
  const [debugDraftSettings, setDebugDraftSettings] =
    useState<ProxyDebugSettingsState>(DEFAULT_PROXY_DEBUG_SETTINGS);
  const [debugTraces, setDebugTraces] = useState<ProxyDebugTraceListItem[]>([]);
  const [debugTracePage, setDebugTracePage] = useState(1);
  const [selectedDebugTraceId, setSelectedDebugTraceId] = useState<
    number | null
  >(null);
  const [showDebugTraceDetailModal, setShowDebugTraceDetailModal] =
    useState(false);
  const [debugDetailById, setDebugDetailById] = useState<
    Record<number, ProxyDebugTraceDetailState>
  >({});
  const isMobile = useIsMobile(768);
  const toast = useToast();
  const loadSeq = useRef(0);
  const metaLoadSeq = useRef(0);
  const selectedDebugTraceIdRef = useRef<number | null>(null);
  const debugDetailByIdRef = useRef<Record<number, ProxyDebugTraceDetailState>>(
    {},
  );
  const debugDetailInFlightRef = useRef<Set<number>>(new Set());
  const fromApiBoundary = toApiTimeBoundary(fromInput);
  const toApiBoundaryValue = toApiTimeBoundary(toInput);
  const hasInvalidTimeRange = Boolean(
    fromApiBoundary &&
    toApiBoundaryValue &&
    new Date(fromApiBoundary).getTime() >=
      new Date(toApiBoundaryValue).getTime(),
  );

  useEffect(() => {
    const next = readProxyLogsRouteState(location.search);
    setStatusFilter((current) =>
      current === next.status ? current : next.status,
    );
    setSearchInput((current) =>
      current === next.search ? current : next.search,
    );
    setClientFilter((current) =>
      current === next.client ? current : next.client,
    );
    setSiteFilter((current) =>
      current === next.siteId ? current : next.siteId,
    );
    setModelFilter((current) =>
      current === next.model ? current : next.model,
    );
    setFromInput((current) => (current === next.from ? current : next.from));
    setToInput((current) => (current === next.to ? current : next.to));
    setPage((current) => (current === next.page ? current : next.page));
    setPageSize((current) =>
      current === next.pageSize ? current : next.pageSize,
    );
  }, [location.search]);

  useEffect(() => {
    const nextSearch = buildProxyLogsRouteSearch({
      page,
      pageSize,
      status: statusFilter,
      search: searchInput,
      client: clientFilter,
      siteId: siteFilter,
      model: modelFilter,
      from: fromInput,
      to: toInput,
    });
    if (nextSearch === location.search) return;
    navigate(
      { pathname: location.pathname, search: nextSearch },
      { replace: true },
    );
  }, [
    clientFilter,
    fromInput,
    location.pathname,
    location.search,
    navigate,
    page,
    pageSize,
    searchInput,
    modelFilter,
    siteFilter,
    statusFilter,
    toInput,
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const currentOffset = (safePage - 1) * pageSize;
  const displayedStart = total === 0 ? 0 : currentOffset + 1;
  const displayedEnd =
    total === 0 ? 0 : Math.min(currentOffset + logs.length, total);
  const debugTraceTotalPages = Math.max(
    1,
    Math.ceil(debugTraces.length / DEBUG_TRACE_PAGE_SIZE),
  );
  const safeDebugTracePage = Math.min(debugTracePage, debugTraceTotalPages);
  const debugTraceOffset = (safeDebugTracePage - 1) * DEBUG_TRACE_PAGE_SIZE;
  const visibleDebugTraces = debugTraces.slice(
    debugTraceOffset,
    debugTraceOffset + DEBUG_TRACE_PAGE_SIZE,
  );
  const debugTraceDisplayedStart =
    debugTraces.length === 0 ? 0 : debugTraceOffset + 1;
  const debugTraceDisplayedEnd =
    debugTraces.length === 0
      ? 0
      : Math.min(
          debugTraceOffset + visibleDebugTraces.length,
          debugTraces.length,
        );

  const pageNumbers = useMemo(
    () =>
      Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
        if (totalPages <= 7) return i + 1;
        if (safePage <= 4) return i + 1;
        if (safePage >= totalPages - 3) return totalPages - 6 + i;
        return safePage - 3 + i;
      }),
    [safePage, totalPages],
  );

  const siteOptions = useMemo(() => {
    const options = sites.map((site) => ({
      value: String(site.id),
      label: site.status === "disabled" ? `${site.name}（已禁用）` : site.name,
    }));
    if (
      siteFilter &&
      !options.some((option) => option.value === String(siteFilter))
    ) {
      options.unshift({
        value: String(siteFilter),
        label: `站点 #${siteFilter}（已删除）`,
      });
    }
    return [{ value: "", label: "全部站点" }, ...options];
  }, [siteFilter, sites]);

  const modelSelectOptions = useMemo(() => {
    const options = modelOptions.map((model) => ({
      value: model,
      label: model,
    }));
    if (modelFilter && !options.some((option) => option.value === modelFilter)) {
      options.unshift({
        value: modelFilter,
        label: modelFilter,
      });
    }
    return [{ value: "", label: "全部模型" }, ...options];
  }, [modelFilter, modelOptions]);

  const resolvedClientOptions = useMemo(() => {
    const options = [...clientOptions];
    if (
      clientFilter &&
      !options.some((option) => option.value === clientFilter)
    ) {
      options.unshift({
        value: clientFilter,
        label: clientFilter,
      });
    }
    return [{ value: "", label: "全部客户端" }, ...options];
  }, [clientFilter, clientOptions]);

  const activeSiteLabel = useMemo(() => {
    if (!siteFilter) return "全部站点";
    return (
      siteOptions.find((option) => option.value === String(siteFilter))
        ?.label || `站点 #${siteFilter}`
    );
  }, [siteFilter, siteOptions]);
  const siteIdByName = useMemo(() => {
    const index = new Map<string, number>();
    for (const site of sites) {
      const siteName = String(site?.name || "").trim();
      const siteId = Number(site?.id);
      if (
        !siteName ||
        !Number.isFinite(siteId) ||
        siteId <= 0 ||
        index.has(siteName)
      )
        continue;
      index.set(siteName, Math.trunc(siteId));
    }
    return index;
  }, [sites]);

  const load = useCallback(
    async (silent = false) => {
      const seq = ++loadSeq.current;
      if (hasInvalidTimeRange) {
        setLogs([]);
        setTotal(0);
        setSummary(EMPTY_SUMMARY);
        if (seq === loadSeq.current) setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const params = {
          limit: pageSize,
          offset: currentOffset,
          status: statusFilter,
          search: deferredSearchInput,
          ...(clientFilter ? { client: clientFilter } : {}),
          ...(siteFilter ? { siteId: siteFilter } : {}),
          ...(modelFilter ? { model: modelFilter } : {}),
          ...(fromApiBoundary ? { from: fromApiBoundary } : {}),
          ...(toApiBoundaryValue ? { to: toApiBoundaryValue } : {}),
        };
        const data = await api.getProxyLogsQuery(params);
        if (seq !== loadSeq.current) return;
        setLogs(Array.isArray(data.items) ? data.items : []);
        setTotal(Number(data.total || 0));
      } catch (e: any) {
        if (seq !== loadSeq.current) return;
        if (!silent) toast.error(e.message || "加载日志失败");
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [
      clientFilter,
      currentOffset,
      deferredSearchInput,
      fromApiBoundary,
      hasInvalidTimeRange,
      pageSize,
      modelFilter,
      siteFilter,
      statusFilter,
      toApiBoundaryValue,
      toast,
    ],
  );

  const loadMeta = useCallback(
    async (forceRefresh = false) => {
      const seq = ++metaLoadSeq.current;
      if (hasInvalidTimeRange) {
        setSummary(EMPTY_SUMMARY);
        setClientOptions([]);
        return;
      }

      try {
        const data = await api.getProxyLogsMeta({
          status: statusFilter,
          search: deferredSearchInput,
          ...(clientFilter ? { client: clientFilter } : {}),
          ...(siteFilter ? { siteId: siteFilter } : {}),
          ...(modelFilter ? { model: modelFilter } : {}),
          ...(fromApiBoundary ? { from: fromApiBoundary } : {}),
          ...(toApiBoundaryValue ? { to: toApiBoundaryValue } : {}),
          ...(forceRefresh ? { refresh: 1 } : {}),
        });
        if (seq !== metaLoadSeq.current) return;
        setSummary(data.summary || EMPTY_SUMMARY);
        setClientOptions(
          Array.isArray(data.clientOptions) ? data.clientOptions : [],
        );
        const normalized: ProxyLogSiteFilterOption[] = (
          Array.isArray(data.sites) ? data.sites : []
        )
          .map((site: any) => ({
            id: Number(site?.id || 0),
            name: String(site?.name || "").trim() || `站点 #${site?.id ?? ""}`,
            status: typeof site?.status === "string" ? site.status : null,
          }))
          .filter((site: ProxyLogSiteFilterOption) => site.id > 0)
          .sort(
            (left: ProxyLogSiteFilterOption, right: ProxyLogSiteFilterOption) =>
              left.name.localeCompare(right.name, "zh-CN"),
          );
        setSites(normalized);
        setModelOptions(Array.isArray(data.models) ? data.models : []);
      } catch (error) {
        if (seq !== metaLoadSeq.current) return;
        console.error("Failed to load proxy log meta:", error);
      }
    },
    [
      clientFilter,
      deferredSearchInput,
      fromApiBoundary,
      hasInvalidTimeRange,
      siteFilter,
      statusFilter,
      toApiBoundaryValue,
    ],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      void load(true);
    }, 2000);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  useEffect(() => {
    if (page <= totalPages) return;
    setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    if (debugTracePage <= debugTraceTotalPages) return;
    setDebugTracePage(debugTraceTotalPages);
  }, [debugTracePage, debugTraceTotalPages]);

  useEffect(() => {
    setExpanded((current) =>
      current !== null && logs.some((log) => log.id === current)
        ? current
        : null,
    );
  }, [logs]);

  useEffect(() => {
    selectedDebugTraceIdRef.current = selectedDebugTraceId;
  }, [selectedDebugTraceId]);

  useEffect(() => {
    debugDetailByIdRef.current = debugDetailById;
  }, [debugDetailById]);

  const loadDetail = useCallback(
    async (id: number) => {
      const existing = detailById[id];
      if (existing?.loading || existing?.data) return;

      setDetailById((current) => ({
        ...current,
        [id]: { loading: true },
      }));

      try {
        const data = await api.getProxyLogDetail(id);
        setDetailById((current) => ({
          ...current,
          [id]: { loading: false, data },
        }));
      } catch (e: any) {
        const message = e?.message || "加载日志详情失败";
        setDetailById((current) => ({
          ...current,
          [id]: { loading: false, error: message },
        }));
        toast.error(message);
      }
    },
    [detailById, toast],
  );

  const applyLoadedDebugSettings = useCallback(
    (
      nextSettings: ProxyDebugSettingsState,
      options?: { syncDraft?: boolean },
    ) => {
      setDebugSettings(nextSettings);
      if (options?.syncDraft || !showDebugSettingsModal) {
        setDebugDraftSettings(nextSettings);
      }
    },
    [showDebugSettingsModal],
  );

  const loadDebugTraceDetail = useCallback(
    async (
      id: number,
      options?: {
        force?: boolean;
        suppressToast?: boolean;
        preserveVisibleData?: boolean;
      },
    ) => {
      const existing = debugDetailByIdRef.current[id];
      if (debugDetailInFlightRef.current.has(id)) return;
      if (!options?.force && (existing?.loading || existing?.data)) return;

      debugDetailInFlightRef.current.add(id);

      if (!options?.preserveVisibleData || !existing?.data) {
        setDebugDetailById((current) => ({
          ...current,
          [id]: { loading: true },
        }));
      }

      try {
        const data = await api.getProxyDebugTraceDetail(id);
        setDebugDetailById((current) => ({
          ...current,
          [id]: { loading: false, data },
        }));
      } catch (error: any) {
        const message = error?.message || "加载调试追踪详情失败";
        setDebugDetailById((current) => ({
          ...current,
          [id]: { loading: false, error: message },
        }));
        if (!options?.suppressToast) {
          toast.error(message);
        }
      } finally {
        debugDetailInFlightRef.current.delete(id);
      }
    },
    [toast],
  );

  const syncDebugTraceItems = useCallback(
    async (
      items: ProxyDebugTraceListItem[],
      options?: { refreshSelectedDetail?: boolean },
    ) => {
      setDebugTraces(items);
      const currentSelectedDebugTraceId = selectedDebugTraceIdRef.current;
      const nextSelectedDebugTraceId =
        currentSelectedDebugTraceId &&
        items.some((item) => item.id === currentSelectedDebugTraceId)
          ? currentSelectedDebugTraceId
          : null;
      selectedDebugTraceIdRef.current = nextSelectedDebugTraceId;
      setSelectedDebugTraceId(nextSelectedDebugTraceId);
      if (nextSelectedDebugTraceId && options?.refreshSelectedDetail) {
        await loadDebugTraceDetail(nextSelectedDebugTraceId, {
          force: true,
          suppressToast: true,
          preserveVisibleData: showDebugTraceDetailModal,
        });
      }
    },
    [loadDebugTraceDetail, showDebugTraceDetailModal],
  );

  const loadDebugTraceList = useCallback(
    async (options?: {
      silent?: boolean;
      refreshSelectedDetail?: boolean;
      suppressToast?: boolean;
    }) => {
      if (!options?.silent) setDebugPanelLoading(true);
      try {
        const traceResponse = await api.getProxyDebugTraces({
          limit: TRACE_TABLE_LIMIT,
        });
        const items = Array.isArray(traceResponse?.items)
          ? traceResponse.items
          : [];
        await syncDebugTraceItems(items, {
          refreshSelectedDetail: options?.refreshSelectedDetail,
        });
      } catch (error: any) {
        if (!options?.suppressToast) {
          toast.error(error?.message || "加载代理调试追踪失败");
        }
      } finally {
        if (!options?.silent) setDebugPanelLoading(false);
      }
    },
    [syncDebugTraceItems, toast],
  );

  const loadDebugState = useCallback(
    async (silent = false) => {
      if (!silent) setDebugPanelLoading(true);
      try {
        const [runtimeSettings, traceResponse] = await Promise.all([
          api.getRuntimeSettings(),
          api.getProxyDebugTraces({ limit: TRACE_TABLE_LIMIT }),
        ]);
        applyLoadedDebugSettings(normalizeProxyDebugSettings(runtimeSettings), {
          syncDraft: true,
        });
        const items = Array.isArray(traceResponse?.items)
          ? traceResponse.items
          : [];
        await syncDebugTraceItems(items, { refreshSelectedDetail: true });
      } catch (error: any) {
        toast.error(error?.message || "加载代理调试面板失败");
      } finally {
        if (!silent) setDebugPanelLoading(false);
      }
    },
    [applyLoadedDebugSettings, syncDebugTraceItems, toast],
  );

  useEffect(() => {
    void loadDebugState();
  }, [loadDebugState]);

  useEffect(() => {
    if (!selectedDebugTraceId || !showDebugTraceDetailModal) return;
    void loadDebugTraceDetail(selectedDebugTraceId);
  }, [loadDebugTraceDetail, selectedDebugTraceId, showDebugTraceDetailModal]);

  useEffect(() => {
    if (!debugSettings.proxyDebugTraceEnabled) return;
    const timer = setInterval(() => {
      void loadDebugTraceList({
        silent: true,
        refreshSelectedDetail: true,
        suppressToast: true,
      });
    }, DEBUG_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [debugSettings.proxyDebugTraceEnabled, loadDebugTraceList]);

  useEffect(() => {
    persistDebugTracePanelExpanded(debugTracePanelExpanded);
  }, [debugTracePanelExpanded]);

  const persistDebugSettings = useCallback(
    async (
      nextSettings: ProxyDebugSettingsState,
      options?: { successMessage?: string; closeAfterSave?: boolean },
    ) => {
      setDebugPanelSaving(true);
      try {
        const updated = await api.updateRuntimeSettings(
          buildProxyDebugSettingsPayload(nextSettings),
        );
        const normalized = normalizeProxyDebugSettings(updated);
        applyLoadedDebugSettings(normalized, { syncDraft: true });
        if (normalized.proxyDebugTraceEnabled) {
          setDebugTracePanelExpanded(true);
        }
        if (options?.closeAfterSave) {
          setShowDebugSettingsModal(false);
        }
        if (options?.successMessage) {
          toast.success(options.successMessage);
        }
        await loadDebugTraceList({
          silent: true,
          refreshSelectedDetail: true,
          suppressToast: true,
        });
        return normalized;
      } catch (error: any) {
        toast.error(error?.message || "保存代理调试设置失败");
        return null;
      } finally {
        setDebugPanelSaving(false);
      }
    },
    [applyLoadedDebugSettings, loadDebugTraceList, toast],
  );

  const handleSaveDebugSettings = useCallback(async () => {
    await persistDebugSettings(debugDraftSettings, {
      successMessage: "代理调试设置已保存",
      closeAfterSave: true,
    });
  }, [debugDraftSettings, persistDebugSettings]);

  const handleQuickToggleDebugTrace = useCallback(async () => {
    await persistDebugSettings(
      {
        ...debugSettings,
        proxyDebugTraceEnabled: !debugSettings.proxyDebugTraceEnabled,
      },
      {
        successMessage: debugSettings.proxyDebugTraceEnabled
          ? "代理调试追踪已关闭"
          : "代理调试追踪已开启",
      },
    );
  }, [debugSettings, persistDebugSettings]);

  const handleClearDebugTraces = useCallback(async () => {
    if (debugPanelSaving) return;
    const confirmed = globalThis.confirm?.(
      "确定删除全部代理调试追踪？删除后编号会从 1 重新开始。",
    );
    if (confirmed === false) return;

    setDebugPanelSaving(true);
    try {
      const result = await api.clearProxyDebugTraces();
      setSelectedDebugTraceId(null);
      setShowDebugTraceDetailModal(false);
      setDebugDetailById({});
      setDebugTracePage(1);
      await syncDebugTraceItems([], { refreshSelectedDetail: false });
      toast.success(
        `已删除 ${result.deletedTraces} 条调试追踪（尝试 ${result.deletedAttempts} 条），编号已重置`,
      );
    } catch (error: any) {
      toast.error(error?.message || "删除调试追踪失败");
    } finally {
      setDebugPanelSaving(false);
    }
  }, [debugPanelSaving, syncDebugTraceItems, toast]);

  const handleToggleExpand = useCallback(
    (id: number) => {
      const shouldExpand = expanded !== id;
      setExpanded(shouldExpand ? id : null);
      if (shouldExpand) {
        void loadDetail(id);
      }
    },
    [expanded, loadDetail],
  );
  const selectedDebugTraceDetail = selectedDebugTraceId
    ? debugDetailById[selectedDebugTraceId]
    : undefined;
  const selectedDebugTraceListItem = selectedDebugTraceId
    ? debugTraces.find((trace) => trace.id === selectedDebugTraceId) || null
    : null;
  const closeDebugTraceDetailModal = useCallback(() => {
    setShowDebugTraceDetailModal(false);
  }, []);
  const openDebugTraceDetailModal = useCallback((traceId: number) => {
    selectedDebugTraceIdRef.current = traceId;
    setSelectedDebugTraceId(traceId);
    setShowDebugTraceDetailModal(true);
  }, []);
  const handleCopyStoredDebugValue = useCallback(
    async (label: string, value: unknown) => {
      const normalized = parseStoredDebugPreview(value);
      if (!normalized.raw) {
        toast.error(`${label}为空，无法复制`);
        return;
      }
      try {
        await copyTextToClipboard(normalized.raw);
        toast.success(`已复制${label}`);
      } catch (error: any) {
        toast.error(error?.message || `复制${label}失败`);
      }
    },
    [toast],
  );

  function renderTraceStatusBadge(trace: ProxyDebugTraceListItem) {
    const failed = trace.finalStatus === "failed";
    return (
      <span
        className={`badge ${failed ? "badge-error" : "badge-success"}`}
        style={{ fontSize: 11 }}
      >
        {failed ? "失败" : "成功"}
      </span>
    );
  }

  function renderAttemptDetail(attempt: ProxyDebugTraceAttempt) {
    const serializedAttempt = [
      `targetUrl: ${attempt.targetUrl}`,
      `runtimeExecutor: ${attempt.runtimeExecutor || "-"}`,
      `recoverApplied: ${attempt.recoverApplied ? "true" : "false"}`,
      `downgradeDecision: ${attempt.downgradeDecision ? "true" : "false"}`,
      `downgradeReason: ${attempt.downgradeReason || "-"}`,
      "",
      "requestHeaders:",
      stringifyStoredDebugValue(attempt.requestHeadersJson) || "-",
      "",
      "requestBody:",
      stringifyStoredDebugValue(attempt.requestBodyJson) || "-",
      "",
      "responseHeaders:",
      stringifyStoredDebugValue(attempt.responseHeadersJson) || "-",
      "",
      "responseBody:",
      stringifyStoredDebugValue(attempt.responseBodyJson) || "-",
      "",
      "rawErrorText:",
      attempt.rawErrorText || "-",
      "",
      "memoryWrite:",
      stringifyStoredDebugValue(attempt.memoryWriteJson) || "-",
    ].join("\n");

    return (
      <DetailDisclosureCard
        key={attempt.id}
        title={`#${attempt.attemptIndex + 1} · ${attempt.endpoint} · ${attempt.responseStatus ?? "-"} · ${attempt.requestPath}`}
      >
        <div style={{ padding: 12, display: "grid", gap: 12 }}>
          <div style={detailInfoGridStyle}>
            <div style={detailInfoItemStyle}>
              <div style={detailInfoLabelStyle}>目标地址</div>
              <div
                style={{
                  ...detailInfoValueStyle,
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                }}
              >
                {attempt.targetUrl || "-"}
              </div>
            </div>
            <div style={detailInfoItemStyle}>
              <div style={detailInfoLabelStyle}>执行器</div>
              <div style={detailInfoValueStyle}>
                {attempt.runtimeExecutor || "-"}
              </div>
            </div>
            <div style={detailInfoItemStyle}>
              <div style={detailInfoLabelStyle}>恢复逻辑</div>
              <div style={detailInfoValueStyle}>
                {attempt.recoverApplied ? "已应用" : "未应用"}
              </div>
            </div>
            <div style={detailInfoItemStyle}>
              <div style={detailInfoLabelStyle}>降级决策</div>
              <div style={detailInfoValueStyle}>
                {attempt.downgradeDecision ? "已触发" : "未触发"}
              </div>
            </div>
          </div>
          {attempt.downgradeReason ? (
            <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
              降级原因：{attempt.downgradeReason}
            </div>
          ) : null}
          <pre style={debugCodeBlockStyle}>{serializedAttempt}</pre>
        </div>
      </DetailDisclosureCard>
    );
  }

  function renderStoredDebugDetails(
    title: string,
    value: unknown,
    options?: { defaultOpen?: boolean; copyLabel?: string },
  ) {
    const normalized = parseStoredDebugPreview(value);
    const copyLabel = options?.copyLabel || title;

    return (
      <DetailDisclosureCard title={title} defaultOpen={options?.defaultOpen}>
        <div style={{ padding: 12, display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{
                border: "1px solid var(--color-border)",
                padding: "6px 12px",
              }}
              aria-label={`复制${copyLabel}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void handleCopyStoredDebugValue(copyLabel, value);
              }}
            >
              复制当前保存内容
            </button>
          </div>
          {normalized.note ? (
            <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
              {normalized.note}
            </div>
          ) : null}
          <pre style={debugCodeBlockStyle}>{normalized.displayText}</pre>
        </div>
      </DetailDisclosureCard>
    );
  }

  function renderDebugTraceDetailContent() {
    if (!selectedDebugTraceId) {
      return (
        <div style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
          暂无追踪详情。请选择一条最近追踪后再查看。
        </div>
      );
    }

    if (selectedDebugTraceDetail?.loading) {
      return (
        <div style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
          加载追踪详情中...
        </div>
      );
    }

    if (selectedDebugTraceDetail?.error) {
      return (
        <div style={{ color: "var(--color-danger)", fontSize: 13 }}>
          {selectedDebugTraceDetail.error}
        </div>
      );
    }

    if (!selectedDebugTraceDetail?.data) {
      return (
        <div style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
          暂无追踪详情。
        </div>
      );
    }

    const traceDetail = selectedDebugTraceDetail.data.trace;

    return (
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ ...formSectionStyle, gap: 10 }}>
          <div style={detailSectionTitleStyle}>基础信息</div>
          <div style={detailInfoGridStyle}>
            <div style={detailInfoItemStyle}>
              <div style={detailInfoLabelStyle}>下游路径</div>
              <div style={detailInfoValueStyle}>
                {traceDetail.downstreamPath || "-"}
              </div>
            </div>
            <div style={detailInfoItemStyle}>
              <div style={detailInfoLabelStyle}>Session</div>
              <div style={detailInfoValueStyle}>
                {traceDetail.sessionId || "-"}
              </div>
            </div>
            <div style={detailInfoItemStyle}>
              <div style={detailInfoLabelStyle}>模型</div>
              <div style={detailInfoValueStyle}>
                {traceDetail.requestedModel || "-"}
              </div>
            </div>
            <div style={detailInfoItemStyle}>
              <div style={detailInfoLabelStyle}>最终上游路径</div>
              <div style={detailInfoValueStyle}>
                {traceDetail.finalUpstreamPath || "-"}
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {renderStoredDebugDetails(
            "候选 endpoint",
            traceDetail.endpointCandidatesJson,
            {
              copyLabel: "候选 endpoint",
            },
          )}
          {renderStoredDebugDetails(
            "原始下游请求头",
            traceDetail.requestHeadersJson,
            {
              copyLabel: "原始下游请求头",
            },
          )}
          {renderStoredDebugDetails(
            "原始下游请求体",
            traceDetail.requestBodyJson,
            {
              copyLabel: "原始下游请求体",
            },
          )}
          {renderStoredDebugDetails(
            "最终响应",
            traceDetail.finalResponseBodyJson,
            {
              copyLabel: "最终响应",
            },
          )}
        </div>

        <DetailDisclosureCard
          title={`Attempt 记录 (${selectedDebugTraceDetail.data.attempts.length})`}
        >
          <div style={{ padding: 12, display: "grid", gap: 8 }}>
            {selectedDebugTraceDetail.data.attempts.length === 0 ? (
              <div style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
                暂无 attempt 记录
              </div>
            ) : (
              selectedDebugTraceDetail.data.attempts.map(renderAttemptDetail)
            )}
          </div>
        </DetailDisclosureCard>
      </div>
    );
  }

  const filterControls = (
    <>
      <div className="pill-tabs">
        {[
          {
            key: "all" as ProxyLogStatusFilter,
            label: "全部",
            count: summary.totalCount,
          },
          {
            key: "success" as ProxyLogStatusFilter,
            label: "成功",
            count: summary.successCount,
          },
          {
            key: "failed" as ProxyLogStatusFilter,
            label: "失败",
            count: summary.failedCount,
          },
        ].map((tab) => (
          <button
            key={tab.key}
            className={`pill-tab ${statusFilter === tab.key ? "active" : ""}`}
            onClick={() => {
              setStatusFilter(tab.key);
              setPage(1);
            }}
          >
            {tab.label}{" "}
            <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.7 }}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>
      <div className="proxy-logs-filter-select">
        <ModernSelect
          size="sm"
          value={clientFilter}
          onChange={(nextValue) => {
            setClientFilter(nextValue);
            setPage(1);
          }}
          options={resolvedClientOptions}
          placeholder="全部客户端"
        />
      </div>
      <div className="proxy-logs-filter-select">
        <ModernSelect
          size="sm"
          value={siteFilter ? String(siteFilter) : ""}
          onChange={(nextValue) => {
            setSiteFilter(nextValue ? Number(nextValue) : null);
            setPage(1);
          }}
          options={siteOptions}
          placeholder="全部站点"
        />
      </div>
      <div className="proxy-logs-filter-select">
        <ModernSelect
          size="sm"
          value={modelFilter || ""}
          onChange={(nextValue) => {
            setModelFilter(nextValue || "");
            setPage(1);
          }}
          options={modelSelectOptions}
          placeholder="全部模型"
        />
      </div>
      <label className="proxy-logs-time-field">
        <span>开始</span>
        <input
          type="datetime-local"
          value={fromInput}
          max={toInput || undefined}
          onChange={(e) => {
            setFromInput(e.target.value);
            setPage(1);
          }}
        />
      </label>
      <label className="proxy-logs-time-field">
        <span>结束</span>
        <input
          type="datetime-local"
          value={toInput}
          min={fromInput || undefined}
          onChange={(e) => {
            setToInput(e.target.value);
            setPage(1);
          }}
        />
      </label>
      <div className="toolbar-search" style={{ maxWidth: 280 }}>
        <svg
          width="14"
          height="14"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            setPage(1);
          }}
          placeholder="搜索模型、下游 Key、主分组、标签..."
        />
      </div>
      <button
        type="button"
        className="btn btn-ghost proxy-logs-filter-reset"
        onClick={() => {
          setStatusFilter("all");
          setClientFilter("");
          setSiteFilter(null);
          setModelFilter("");
          setFromInput("");
          setToInput("");
          setSearchInput("");
          setPage(1);
        }}
      >
        清空筛选
      </button>
    </>
  );

  const latestDebugTrace = debugTraces[0] || null;
  const debugSettingsFooter = (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        justifyContent: "flex-end",
      }}
    >
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => setDebugDraftSettings(DEFAULT_PROXY_DEBUG_SETTINGS)}
      >
        重置为默认值
      </button>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void handleSaveDebugSettings()}
        disabled={debugPanelSaving}
      >
        {debugPanelSaving ? "保存中..." : "保存调试设置"}
      </button>
    </div>
  );
  const debugSettingsForm = (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="info-tip" style={{ marginBottom: 0 }}>
        只记录开启后的新请求。需要更精确定位时，再按
        Session、客户端或模型定向过滤。
      </div>

      <div style={formSectionStyle}>
        <div style={formSectionLabelStyle}>记录内容</div>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gap: 4 }}>
            <label style={debugCheckboxRowStyle}>
              <input
                type="checkbox"
                checked={debugDraftSettings.proxyDebugTraceEnabled}
                data-debug-setting="trace-enabled"
                onChange={(e) =>
                  setDebugDraftSettings((current) => ({
                    ...current,
                    proxyDebugTraceEnabled: !!e.target.checked,
                  }))
                }
              />
              开启调试追踪
            </label>
            <div
              style={{
                fontSize: 12,
                color: "var(--color-text-muted)",
                marginLeft: 24,
              }}
            >
              后续新请求会写入调试追踪，不会回补旧请求。
            </div>
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            <label style={debugCheckboxRowStyle}>
              <input
                type="checkbox"
                checked={debugDraftSettings.proxyDebugCaptureHeaders}
                data-debug-setting="capture-headers"
                onChange={(e) =>
                  setDebugDraftSettings((current) => ({
                    ...current,
                    proxyDebugCaptureHeaders: !!e.target.checked,
                  }))
                }
              />
              采集原始请求/响应头
            </label>
            <div
              style={{
                fontSize: 12,
                color: "var(--color-text-muted)",
                marginLeft: 24,
              }}
            >
              保留下游原始头和上游响应头，方便直接对照。
            </div>
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            <label style={debugCheckboxRowStyle}>
              <input
                type="checkbox"
                checked={debugDraftSettings.proxyDebugCaptureBodies}
                data-debug-setting="capture-bodies"
                onChange={(e) =>
                  setDebugDraftSettings((current) => ({
                    ...current,
                    proxyDebugCaptureBodies: !!e.target.checked,
                  }))
                }
              />
              采集请求体和响应体
            </label>
            <div
              style={{
                fontSize: 12,
                color: "var(--color-text-muted)",
                marginLeft: 24,
              }}
            >
              默认不抓 body，只有显式开启后才记录。
            </div>
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            <label style={debugCheckboxRowStyle}>
              <input
                type="checkbox"
                checked={debugDraftSettings.proxyDebugCaptureStreamChunks}
                data-debug-setting="capture-stream-chunks"
                onChange={(e) =>
                  setDebugDraftSettings((current) => ({
                    ...current,
                    proxyDebugCaptureStreamChunks: !!e.target.checked,
                  }))
                }
              />
              采集流式原始分片
            </label>
            <div
              style={{
                fontSize: 12,
                color: "var(--color-text-muted)",
                marginLeft: 24,
              }}
            >
              适合定位 SSE / streaming 过程中的兼容问题。
            </div>
          </div>
        </div>
      </div>

      <ResponsiveFormGrid columns={2}>
        <div style={formSectionStyle}>
          <div style={formSectionLabelStyle}>定向过滤</div>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
              目标 Session ID
            </span>
            <input
              type="text"
              value={debugDraftSettings.proxyDebugTargetSessionId}
              data-debug-setting="target-session-id"
              onChange={(e) =>
                setDebugDraftSettings((current) => ({
                  ...current,
                  proxyDebugTargetSessionId: e.target.value,
                }))
              }
              placeholder="留空表示不过滤"
              style={formInputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
              目标客户端
            </span>
            <input
              type="text"
              value={debugDraftSettings.proxyDebugTargetClientKind}
              data-debug-setting="target-client-kind"
              onChange={(e) =>
                setDebugDraftSettings((current) => ({
                  ...current,
                  proxyDebugTargetClientKind: e.target.value,
                }))
              }
              placeholder="如 codex / claude_code"
              style={formInputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
              目标模型
            </span>
            <input
              type="text"
              value={debugDraftSettings.proxyDebugTargetModel}
              data-debug-setting="target-model"
              onChange={(e) =>
                setDebugDraftSettings((current) => ({
                  ...current,
                  proxyDebugTargetModel: e.target.value,
                }))
              }
              placeholder="如 gpt-4o"
              style={formInputStyle}
            />
          </label>
        </div>

        <div style={formSectionStyle}>
          <div style={formSectionLabelStyle}>保留策略</div>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
              保留时长（小时）
            </span>
            <input
              type="number"
              min={1}
              value={debugDraftSettings.proxyDebugRetentionHours}
              data-debug-setting="retention-hours"
              onChange={(e) =>
                setDebugDraftSettings((current) => ({
                  ...current,
                  proxyDebugRetentionHours: Number(e.target.value || 1),
                }))
              }
              style={formInputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
              抓取体积上限（字节）
            </span>
            <input
              type="number"
              min={1024}
              value={debugDraftSettings.proxyDebugMaxBodyBytes}
              data-debug-setting="max-body-bytes"
              onChange={(e) =>
                setDebugDraftSettings((current) => ({
                  ...current,
                  proxyDebugMaxBodyBytes: Number(e.target.value || 1024),
                }))
              }
              style={formInputStyle}
            />
          </label>
        </div>
      </ResponsiveFormGrid>

      {isMobile ? debugSettingsFooter : null}
    </div>
  );

  return (
    <div className="animate-fade-in">
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <h2 className="page-title">{tr("使用日志")}</h2>
          <div className="page-subtitle">
            按站点、客户端和时间筛选代理请求，并在需要时查看最近调试追踪。
          </div>
        </div>
        <div
          className="page-actions"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <span className="kpi-chip">{activeSiteLabel}</span>
          <span className="kpi-chip kpi-chip-success">
            消耗总额 ${summary.totalCost.toFixed(4)}
          </span>
          <span className="kpi-chip kpi-chip-warning">
            {summary.totalTokensAll.toLocaleString()} tokens
          </span>
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`btn btn-ghost${autoRefresh ? " btn-ghost-active" : ""}`}
            style={{
              border: "1px solid var(--color-border)",
              padding: "6px 14px",
            }}
            title={autoRefresh ? "关闭自动刷新" : "开启自动刷新（每2秒）"}
          >
            <svg
              width="14"
              height="14"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              style={{
                animation: autoRefresh ? "spin 1s linear infinite" : "none",
              }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            {autoRefresh ? "自动刷新中" : "自动刷新"}
          </button>
          <button
            onClick={() => {
              void load();
              void loadMeta(true);
            }}
            disabled={loading}
            className="btn btn-ghost"
            style={{
              border: "1px solid var(--color-border)",
              padding: "6px 14px",
            }}
          >
            <svg
              width="14"
              height="14"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              style={{
                animation: loading ? "spin 1s linear infinite" : "none",
              }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            {loading ? "加载中..." : "刷新"}
          </button>
        </div>
      </div>

      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={showFilters}
        onMobileOpen={() => setShowFilters(true)}
        onMobileClose={() => setShowFilters(false)}
        mobileTitle={tr("筛选日志")}
        mobileContent={filterControls}
        desktopContent={
          <div className="toolbar" style={{ marginBottom: 12 }}>
            {filterControls}
          </div>
        }
      />

      <div
        className="card"
        style={{
          marginBottom: 12,
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--color-text-primary)",
              }}
            >
              代理调试追踪
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--color-text-muted)",
                marginTop: 4,
              }}
            >
              未开启时不记录新追踪；追踪详情通过弹窗按需查看。
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ border: "1px solid var(--color-border)" }}
              aria-expanded={debugTracePanelExpanded}
              data-debug-trace-panel-toggle
              onClick={() => setDebugTracePanelExpanded((current) => !current)}
            >
              <svg
                width="14"
                height="14"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                style={{
                  transform: debugTracePanelExpanded
                    ? "rotate(180deg)"
                    : "rotate(0deg)",
                  transition: "transform 0.2s ease",
                }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
              {debugTracePanelExpanded ? "收起追踪面板" : "展开追踪面板"}
            </button>
            <button
              type="button"
              className={
                debugSettings.proxyDebugTraceEnabled
                  ? "btn btn-ghost btn-ghost-active"
                  : "btn btn-ghost"
              }
              style={{ border: "1px solid var(--color-border)" }}
              onClick={() => void handleQuickToggleDebugTrace()}
              disabled={debugPanelSaving}
            >
              {debugSettings.proxyDebugTraceEnabled ? "关闭调试" : "开启调试"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ border: "1px solid var(--color-border)" }}
              onClick={() => {
                setDebugDraftSettings(debugSettings);
                setShowDebugSettingsModal(true);
              }}
            >
              调试设置
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ border: "1px solid var(--color-border)" }}
              onClick={() => void loadDebugState()}
              disabled={debugPanelLoading}
            >
              {debugPanelLoading ? "刷新中..." : "刷新追踪"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ border: "1px solid var(--color-border)" }}
              onClick={() => void handleClearDebugTraces()}
              disabled={debugPanelSaving || debugPanelLoading}
              data-tooltip="删除全部调试追踪，下一条从 #1 开始"
            >
              删除追踪
            </button>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "12px 18px",
            alignItems: "center",
          }}
        >
          <CompactSummaryMetric
            label="状态"
            value={debugSettings.proxyDebugTraceEnabled ? "已开启" : "未开启"}
          />
          <CompactSummaryMetric
            label="最近追踪"
            value={`${debugTraces.length} 条`}
          />
          <CompactSummaryMetric
            label="最新时间"
            value={
              latestDebugTrace
                ? formatDateTimeLocal(latestDebugTrace.createdAt)
                : "暂无"
            }
          />
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            记录内容：{formatProxyDebugCaptureSummary(debugSettings)}
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            过滤范围：{formatProxyDebugTargetSummary(debugSettings)}
          </div>
        </div>
      </div>

      <div
        className={`anim-collapse ${debugTracePanelExpanded ? "is-open" : ""}`.trim()}
        data-debug-trace-panel-body
        style={{ marginBottom: debugTracePanelExpanded ? 12 : 0 }}
      >
        <div className="anim-collapse-inner">
          <div className="card" style={{ padding: 12, overflowX: "auto" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--color-text-primary)",
                  }}
                >
                  最近调试追踪
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--color-text-muted)",
                    marginTop: 4,
                  }}
                >
                  最多抓最近 20 条，列表分页每页 5
                  条；打开详情后各段内容可按需展开和收起。
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                {debugSettings.proxyDebugTraceEnabled
                  ? "开启中，结果会自动刷新"
                  : "尚未开启"}
              </div>
            </div>

            {debugPanelLoading && debugTraces.length === 0 ? (
              <div
                style={{
                  color: "var(--color-text-muted)",
                  fontSize: 13,
                  paddingBottom: 12,
                }}
              >
                加载调试追踪中...
              </div>
            ) : debugTraces.length === 0 ? (
              <div
                style={{
                  padding: 14,
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-border-light)",
                  background: "var(--color-bg)",
                  color: "var(--color-text-muted)",
                  fontSize: 12,
                  lineHeight: 1.6,
                }}
              >
                {debugSettings.proxyDebugTraceEnabled
                  ? "暂时还没有新追踪。这里只显示开启后产生的新请求，等下一次代理请求进入就会出现在这里。"
                  : "调试追踪尚未开启。点击上方“开启调试”或“调试设置”后，新的代理请求会出现在这里。"}
              </div>
            ) : isMobile ? (
              <div className="mobile-card-list">
                {visibleDebugTraces.map((trace) => (
                  <MobileCard
                    key={trace.id}
                    title={trace.sessionId || `trace-${trace.id}`}
                    subtitle={formatDateTimeLocal(trace.createdAt)}
                    compact
                    headerActions={renderTraceStatusBadge(trace)}
                    footerActions={
                      <button
                        type="button"
                        className="btn btn-link"
                        onClick={() => openDebugTraceDetailModal(trace.id)}
                      >
                        查看详情
                      </button>
                    }
                  >
                    <MobileField
                      label="模型"
                      value={trace.requestedModel || "-"}
                    />
                    <MobileField
                      label="下游路径"
                      value={trace.downstreamPath || "-"}
                    />
                    <MobileField
                      label="上游路径"
                      value={trace.finalUpstreamPath || "-"}
                    />
                    <MobileField
                      label="客户端"
                      value={trace.clientKind || "-"}
                    />
                  </MobileCard>
                ))}
              </div>
            ) : (
              <table className="data-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>Session</th>
                    <th>模型</th>
                    <th>下游路径</th>
                    <th>上游路径</th>
                    <th>客户端</th>
                    <th>{tr("状态")}</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDebugTraces.map((trace) => (
                    <tr key={trace.id}>
                      <td
                        style={{
                          fontSize: 12,
                          whiteSpace: "nowrap",
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        {formatDateTimeLocal(trace.createdAt)}
                      </td>
                      <td style={{ fontSize: 12, fontWeight: 600 }}>
                        {trace.sessionId || `trace-${trace.id}`}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {trace.requestedModel || "-"}
                      </td>
                      <td
                        style={{
                          fontSize: 12,
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        {trace.downstreamPath || "-"}
                      </td>
                      <td
                        style={{
                          fontSize: 12,
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        {trace.finalUpstreamPath || "-"}
                      </td>
                      <td
                        style={{
                          fontSize: 12,
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        {trace.clientKind || "-"}
                      </td>
                      <td>{renderTraceStatusBadge(trace)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-link"
                          onClick={() => openDebugTraceDetailModal(trace.id)}
                        >
                          查看详情
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {debugTraces.length > 0 ? (
              <div className="pagination" style={{ marginTop: 12 }}>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--color-text-muted)",
                    marginRight: "auto",
                  }}
                >
                  显示第 {debugTraceDisplayedStart} - {debugTraceDisplayedEnd}{" "}
                  条，共 {debugTraces.length} 条
                </div>
                <button
                  className="pagination-btn"
                  aria-label="调试追踪上一页"
                  disabled={safeDebugTracePage <= 1}
                  onClick={() => setDebugTracePage((current) => current - 1)}
                >
                  <svg
                    width="14"
                    height="14"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                </button>
                {Array.from(
                  { length: debugTraceTotalPages },
                  (_, index) => index + 1,
                ).map((num) => (
                  <button
                    key={`debug-trace-page-${num}`}
                    className={`pagination-btn ${safeDebugTracePage === num ? "active" : ""}`}
                    onClick={() => setDebugTracePage(num)}
                  >
                    {num}
                  </button>
                ))}
                <button
                  className="pagination-btn"
                  aria-label="调试追踪下一页"
                  disabled={safeDebugTracePage >= debugTraceTotalPages}
                  onClick={() => setDebugTracePage((current) => current + 1)}
                >
                  <svg
                    width="14"
                    height="14"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {isMobile ? (
        <MobileDrawer
          open={showDebugSettingsModal}
          onClose={() => {
            setShowDebugSettingsModal(false);
            setDebugDraftSettings(debugSettings);
          }}
          title="调试设置"
          closeLabel="关闭调试设置"
          side="right"
        >
          <div style={{ padding: 16, display: "grid", gap: 16 }}>
            {debugSettingsForm}
          </div>
        </MobileDrawer>
      ) : (
        <CenteredModal
          open={showDebugSettingsModal}
          onClose={() => {
            setShowDebugSettingsModal(false);
            setDebugDraftSettings(debugSettings);
          }}
          title="调试设置"
          footer={debugSettingsFooter}
          maxWidth={880}
          closeOnBackdrop
          closeOnEscape
        >
          {debugSettingsForm}
        </CenteredModal>
      )}

      {isMobile ? (
        <MobileDrawer
          open={showDebugTraceDetailModal}
          onClose={closeDebugTraceDetailModal}
          title={selectedDebugTraceListItem?.sessionId || "追踪详情"}
          closeLabel="关闭追踪详情"
          side="right"
        >
          <div style={{ padding: 16, display: "grid", gap: 16 }}>
            {renderDebugTraceDetailContent()}
          </div>
        </MobileDrawer>
      ) : (
        <CenteredModal
          open={showDebugTraceDetailModal}
          onClose={closeDebugTraceDetailModal}
          title={selectedDebugTraceListItem?.sessionId || "追踪详情"}
          maxWidth={920}
          closeOnBackdrop
          closeOnEscape
        >
          {renderDebugTraceDetailContent()}
        </CenteredModal>
      )}

      {hasInvalidTimeRange && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          结束时间必须晚于开始时间
        </div>
      )}

      <div className="card" style={{ overflowX: "auto" }}>
        {loading ? (
          <div
            style={{
              padding: 24,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {[...Array(8)].map((_, i) => (
              <div key={i} style={{ display: "flex", gap: 16 }}>
                <div className="skeleton" style={{ width: 140, height: 16 }} />
                <div className="skeleton" style={{ width: 200, height: 16 }} />
                <div className="skeleton" style={{ width: 50, height: 16 }} />
                <div className="skeleton" style={{ width: 50, height: 16 }} />
                <div className="skeleton" style={{ width: 50, height: 16 }} />
                <div className="skeleton" style={{ width: 70, height: 16 }} />
              </div>
            ))}
          </div>
        ) : isMobile ? (
          <div className="mobile-card-list">
            {logs.map((log) => {
              const detailState = detailById[log.id];
              const detail = detailState?.data;
              const detailLog: ProxyLogRenderItem = detail
                ? { ...log, ...detail }
                : log;
              const pathMeta = parseProxyLogPathMeta(
                detailLog.errorMessage ?? undefined,
              );
              const billingDetailSummary = detail
                ? formatBillingDetailSummary(detailLog)
                : null;
              const billingProcessLines = detail
                ? buildBillingProcessLines(detailLog)
                : [];
              const downstreamKeySummary =
                renderDownstreamKeySummary(detailLog);
              const isExpanded = expanded === log.id;
              const streamModeLabel = formatStreamModeLabel(detailLog.isStream);
              const firstByteLabel = formatFirstByteLabel(
                detailLog.firstByteLatencyMs,
              );

              return (
                <MobileCard
                  key={log.id}
                  title={detailLog.modelRequested || "unknown"}
                  subtitle={formatDateTimeLocal(log.createdAt)}
                  compact
                  headerActions={
                    <span
                      className={`badge ${log.status === "success" ? "badge-success" : "badge-error"}`}
                      style={{ fontSize: 10 }}
                    >
                      {log.status === "success" ? "成功" : "失败"}
                    </span>
                  }
                  footerActions={
                    <button
                      type="button"
                      className="btn btn-link"
                      onClick={() => handleToggleExpand(log.id)}
                    >
                      {isExpanded ? "收起详情" : "详情"}
                    </button>
                  }
                >
                  <div className="mobile-inline-meta-row">
                    <SiteBadgeLink
                      siteId={siteIdByName.get(
                        String(log.siteName || "").trim(),
                      )}
                      siteName={log.siteName}
                      badgeStyle={{ fontSize: 11 }}
                    />
                    <StreamModeIcon isStream={detailLog.isStream} />
                  </div>
                  <div className="mobile-summary-grid">
                    <div className="mobile-summary-metric">
                      <div className="mobile-summary-metric-label">首字</div>
                      <div className="mobile-summary-metric-value">
                        {Number.isFinite(detailLog.firstByteLatencyMs)
                          && typeof detailLog.firstByteLatencyMs === "number"
                          && detailLog.firstByteLatencyMs >= 0
                          ? formatLatency(detailLog.firstByteLatencyMs)
                          : "-"}
                      </div>
                    </div>
                    <div className="mobile-summary-metric">
                      <div className="mobile-summary-metric-label">用时</div>
                      <div className="mobile-summary-metric-value">
                        {formatLatency(log.latencyMs)}
                      </div>
                    </div>
                    <div className="mobile-summary-metric">
                      <div className="mobile-summary-metric-label">输入</div>
                      <div className="mobile-summary-metric-value">
                        {formatProxyLogTokenValue(log.promptTokens)}
                      </div>
                    </div>
                    <div className="mobile-summary-metric">
                      <div className="mobile-summary-metric-label">输出</div>
                      <div className="mobile-summary-metric-value">
                        {formatProxyLogTokenValue(log.completionTokens)}
                      </div>
                    </div>
                    <div className="mobile-summary-metric">
                      <div className="mobile-summary-metric-label">花费</div>
                      <div className="mobile-summary-metric-value">
                        {typeof log.estimatedCost === "number"
                          ? `$${log.estimatedCost.toFixed(6)}`
                          : "-"}
                      </div>
                    </div>
                  </div>
                  {isExpanded ? (
                    <div className="mobile-card-extra">
                      <MobileField
                        label="时间"
                        value={formatDateTimeLocal(log.createdAt)}
                      />
                      <MobileField
                        label="站点"
                        value={
                          <SiteBadgeLink
                            siteId={siteIdByName.get(
                              String(log.siteName || "").trim(),
                            )}
                            siteName={log.siteName}
                            badgeStyle={{ fontSize: 11 }}
                          />
                        }
                      />
                      {streamModeLabel ? (
                        <MobileField label="模式" value={streamModeLabel} />
                      ) : null}
                      {firstByteLabel ? (
                        <MobileField
                          label="首字"
                          value={firstByteLabel.replace(/^首字\s*/, "")}
                        />
                      ) : null}
                      <MobileField
                        label="重试"
                        value={log.retryCount > 0 ? log.retryCount : 0}
                      />
                      <MobileField
                        label="用量来源"
                        value={
                          formatProxyLogUsageSource(
                            detailLog.usageSource ?? pathMeta.usageSource,
                          ) || "--"
                        }
                      />
                      {detailState?.loading && (
                        <div style={{ color: "var(--color-text-muted)" }}>
                          加载详情中...
                        </div>
                      )}
                      {detailState?.error && (
                        <div style={{ color: "var(--color-danger)" }}>
                          {detailState.error}
                        </div>
                      )}
                      {billingDetailSummary && (
                        <div style={{ color: "var(--color-text-muted)" }}>
                          {billingDetailSummary}
                        </div>
                      )}
                      <MobileField
                        label="客户端详情"
                        value={renderProxyLogClientCell(detailLog, {
                          includeGeneric: true,
                        })}
                      />
                      {downstreamKeySummary && (
                        <div style={{ color: "var(--color-text-muted)" }}>
                          {downstreamKeySummary}
                        </div>
                      )}
                      {billingProcessLines.length > 0 && (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                          }}
                        >
                          {billingProcessLines.map((line, index) => (
                            <span key={`${log.id}-billing-mobile-${index}`}>
                              {line}
                            </span>
                          ))}
                        </div>
                      )}
                      {detail && pathMeta.errorMessage.trim().length > 0 && (
                        <div style={{ color: "var(--color-danger)" }}>
                          {pathMeta.errorMessage}
                        </div>
                      )}
                    </div>
                  ) : null}
                </MobileCard>
              );
            })}
          </div>
        ) : (
          <table className="data-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>时间</th>
                <th>模型</th>
                <th>站点</th>
                <th style={{ width: 48, minWidth: 48 }} title="流式 / 非流">
                  模式
                </th>
                <th>{tr("状态")}</th>
                <th>首字</th>
                <th>用时</th>
                <th>输入</th>
                <th>输出</th>
                <th>花费</th>
                <th>重试</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const detailState = detailById[log.id];
                const detail = detailState?.data;
                const detailLog: ProxyLogRenderItem = detail
                  ? { ...log, ...detail }
                  : log;
                const pathMeta = parseProxyLogPathMeta(
                  detailLog.errorMessage ?? undefined,
                );
                const billingDetailSummary = detail
                  ? formatBillingDetailSummary(detailLog)
                  : null;
                const billingProcessLines = detail
                  ? buildBillingProcessLines(detailLog)
                  : [];
                const downstreamKeySummary =
                  renderDownstreamKeySummary(detailLog);
                const streamModeLabel = formatStreamModeLabel(
                  detailLog.isStream,
                );
                const firstByteLabel = formatFirstByteLabel(
                  detailLog.firstByteLatencyMs,
                );

                return (
                  <React.Fragment key={log.id}>
                    <tr
                      data-testid={`proxy-log-row-${log.id}`}
                      onClick={() => handleToggleExpand(log.id)}
                      style={{
                        cursor: "pointer",
                        background:
                          expanded === log.id
                            ? "var(--color-primary-light)"
                            : undefined,
                        transition: "background 0.15s",
                      }}
                    >
                      <td style={{ padding: "8px 4px 8px 12px" }}>
                        <svg
                          width="10"
                          height="10"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          style={{
                            transform:
                              expanded === log.id ? "rotate(90deg)" : "none",
                            transition: "transform 0.2s",
                            color: "var(--color-text-muted)",
                          }}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2.5}
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </td>
                      <td
                        style={{
                          fontSize: 12,
                          whiteSpace: "nowrap",
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        {formatDateTimeLocal(log.createdAt)}
                      </td>
                      <td>
                        <ModelBadge
                          model={log.modelRequested}
                          style={{ alignSelf: "flex-start" }}
                        />
                      </td>
                      <td
                        style={{
                          fontSize: 12,
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        <SiteBadgeLink
                          siteId={siteIdByName.get(
                            String(log.siteName || "").trim(),
                          )}
                          siteName={log.siteName}
                          badgeStyle={{ fontSize: 11 }}
                        />
                      </td>
                      <td style={{ width: 48, minWidth: 48 }}>
                        <StreamModeIcon isStream={detailLog.isStream} />
                      </td>
                      <td>
                        <span
                          className={`badge ${log.status === "success" ? "badge-success" : "badge-error"}`}
                          style={{ fontSize: 11, fontWeight: 600 }}
                        >
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background:
                                log.status === "success"
                                  ? "var(--color-success)"
                                  : "var(--color-danger)",
                            }}
                          />
                          {log.status === "success" ? "成功" : "失败"}
                        </span>
                      </td>
                      <td>
                        {Number.isFinite(detailLog.firstByteLatencyMs)
                          && typeof detailLog.firstByteLatencyMs === "number"
                          && detailLog.firstByteLatencyMs >= 0 ? (
                          <span
                            style={{
                              fontVariantNumeric: "tabular-nums",
                              fontSize: 12,
                              fontWeight: 600,
                              color: firstByteColor(detailLog.firstByteLatencyMs),
                              background: firstByteBgColor(
                                detailLog.firstByteLatencyMs,
                              ),
                              padding: "2px 8px",
                              borderRadius: 4,
                            }}
                          >
                            {formatLatency(detailLog.firstByteLatencyMs)}
                          </span>
                        ) : (
                          <span style={{ color: "var(--color-text-muted)" }}>-</span>
                        )}
                      </td>
                      <td>
                        <span
                          style={{
                            fontVariantNumeric: "tabular-nums",
                            fontSize: 12,
                            fontWeight: 600,
                            color: latencyColor(log.latencyMs),
                            background: latencyBgColor(log.latencyMs),
                            padding: "2px 8px",
                            borderRadius: 4,
                          }}
                        >
                          {formatLatency(log.latencyMs)}
                        </span>
                      </td>
                      <td
                        style={{
                          fontSize: 12,
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        {formatProxyLogTokenValue(log.promptTokens)}
                      </td>
                      <td
                        style={{
                          fontSize: 12,
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        {formatProxyLogTokenValue(log.completionTokens)}
                      </td>
                      <td
                        style={{
                          fontSize: 12,
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 500,
                        }}
                      >
                        {typeof log.estimatedCost === "number"
                          ? `$${log.estimatedCost.toFixed(6)}`
                          : "-"}
                      </td>
                      <td>
                        {log.retryCount > 0 ? (
                          <span
                            className="badge badge-warning"
                            style={{ fontSize: 11 }}
                          >
                            {log.retryCount}
                          </span>
                        ) : (
                          <span
                            style={{
                              color: "var(--color-text-muted)",
                              fontSize: 12,
                            }}
                          >
                            0
                          </span>
                        )}
                      </td>
                    </tr>
                    {expanded === log.id && (
                      <tr style={{ background: "var(--color-bg)" }}>
                        <td colSpan={11} style={{ padding: 0 }}>
                          <div className="anim-collapse is-open">
                            <div className="anim-collapse-inner">
                              <div
                                className="animate-fade-in"
                                style={{
                                  padding: "14px 20px 14px 40px",
                                  borderTop:
                                    "1px solid var(--color-border-light)",
                                  borderBottom:
                                    "1px solid var(--color-border-light)",
                                  fontSize: 12,
                                  lineHeight: 1.9,
                                  color: "var(--color-text-secondary)",
                                }}
                              >
                                <div style={{ display: "flex", gap: 6 }}>
                                  <span
                                    style={{
                                      fontWeight: 600,
                                      color: "var(--color-warning)",
                                      flexShrink: 0,
                                    }}
                                  >
                                    日志详情
                                  </span>
                                  <div>
                                    <div>
                                      请求模型:{" "}
                                      <strong
                                        style={{
                                          color: "var(--color-text-primary)",
                                        }}
                                      >
                                        {detailLog.modelRequested}
                                      </strong>
                                      {detailLog.modelActual &&
                                        detailLog.modelActual !==
                                          detailLog.modelRequested && (
                                          <>
                                            {" -> "}实际模型:{" "}
                                            <strong
                                              style={{
                                                color:
                                                  "var(--color-text-primary)",
                                              }}
                                            >
                                              {detailLog.modelActual}
                                            </strong>
                                          </>
                                        )}
                                      ，状态:{" "}
                                      <strong
                                        style={{
                                          color:
                                            detailLog.status === "success"
                                              ? "var(--color-success)"
                                              : "var(--color-danger)",
                                        }}
                                      >
                                        {detailLog.status === "success"
                                          ? "成功"
                                          : "失败"}
                                      </strong>
                                      {streamModeLabel && (
                                        <>
                                          ，模式:{" "}
                                          <strong
                                            style={{
                                              color:
                                                "var(--color-text-primary)",
                                            }}
                                          >
                                            {streamModeLabel}
                                          </strong>
                                        </>
                                      )}
                                      {firstByteLabel && (
                                        <>
                                          ，首字:{" "}
                                          <strong
                                            style={{
                                              color: firstByteColor(
                                                detailLog.firstByteLatencyMs ??
                                                  0,
                                              ),
                                            }}
                                          >
                                            {formatLatency(
                                              detailLog.firstByteLatencyMs ?? 0,
                                            )}
                                          </strong>
                                        </>
                                      )}
                                      ，用时:{" "}
                                      <strong
                                        style={{
                                          color: latencyColor(
                                            detailLog.latencyMs,
                                          ),
                                        }}
                                      >
                                        {formatLatency(detailLog.latencyMs)}
                                      </strong>
                                      {detail && (
                                        <>
                                          ，站点:{" "}
                                          <strong
                                            style={{
                                              color:
                                                "var(--color-text-primary)",
                                            }}
                                          >
                                            {detailLog.siteName || "未知站点"}
                                          </strong>
                                          ，账号:{" "}
                                          <strong
                                            style={{
                                              color:
                                                "var(--color-text-primary)",
                                            }}
                                          >
                                            {detailLog.username || "未知账号"}
                                          </strong>
                                        </>
                                      )}
                                    </div>
                                    {detailState?.loading && (
                                      <div
                                        style={{
                                          color: "var(--color-text-muted)",
                                        }}
                                      >
                                        加载详情中...
                                      </div>
                                    )}
                                    {detailState?.error && (
                                      <div
                                        style={{ color: "var(--color-danger)" }}
                                      >
                                        {detailState.error}
                                      </div>
                                    )}
                                    {billingDetailSummary && (
                                      <div
                                        style={{
                                          color: "var(--color-text-muted)",
                                        }}
                                      >
                                        {billingDetailSummary}
                                      </div>
                                    )}
                                    <div
                                      style={{
                                        color: "var(--color-text-muted)",
                                      }}
                                    >
                                      用量来源：
                                      {formatProxyLogUsageSource(
                                        detailLog.usageSource ??
                                          pathMeta.usageSource,
                                      ) || "未知"}
                                    </div>
                                    <div
                                      style={{
                                        display: "flex",
                                        gap: 6,
                                        alignItems: "flex-start",
                                      }}
                                    >
                                      <span
                                        style={{
                                          color: "var(--color-text-muted)",
                                          flexShrink: 0,
                                        }}
                                      >
                                        客户端
                                      </span>
                                      <div style={{ minWidth: 0 }}>
                                        {renderProxyLogClientCell(detailLog, {
                                          includeGeneric: true,
                                        })}
                                      </div>
                                    </div>
                                    {downstreamKeySummary && (
                                      <div
                                        style={{
                                          color: "var(--color-text-muted)",
                                        }}
                                      >
                                        {downstreamKeySummary}
                                      </div>
                                    )}
                                  </div>
                                </div>

                                {detailLog.billingDetails &&
                                  detailLog.billingDetails.usage
                                    .cacheReadTokens > 0 && (
                                    <div style={{ display: "flex", gap: 6 }}>
                                      <span
                                        style={{
                                          fontWeight: 600,
                                          color: "var(--color-warning)",
                                          flexShrink: 0,
                                        }}
                                      >
                                        缓存 Tokens
                                      </span>
                                      <span>
                                        {detailLog.billingDetails.usage.cacheReadTokens.toLocaleString()}
                                      </span>
                                    </div>
                                  )}

                                {detailLog.billingDetails &&
                                  detailLog.billingDetails.usage
                                    .cacheCreationTokens > 0 && (
                                    <div style={{ display: "flex", gap: 6 }}>
                                      <span
                                        style={{
                                          fontWeight: 600,
                                          color: "var(--color-warning)",
                                          flexShrink: 0,
                                        }}
                                      >
                                        缓存创建 Tokens
                                      </span>
                                      <span>
                                        {detailLog.billingDetails.usage.cacheCreationTokens.toLocaleString()}
                                      </span>
                                    </div>
                                  )}

                                <div style={{ display: "flex", gap: 6 }}>
                                  <span
                                    style={{
                                      fontWeight: 600,
                                      color: "var(--color-info)",
                                      flexShrink: 0,
                                    }}
                                  >
                                    计费过程
                                  </span>
                                  {billingProcessLines.length > 0 ? (
                                    <div
                                      style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 2,
                                      }}
                                    >
                                      {billingProcessLines.map(
                                        (line, index) => (
                                          <span
                                            key={`${log.id}-billing-${index}`}
                                          >
                                            {line}
                                          </span>
                                        ),
                                      )}
                                      <span
                                        style={{
                                          color: "var(--color-text-muted)",
                                        }}
                                      >
                                        仅供参考，以实际扣费为准
                                      </span>
                                    </div>
                                  ) : (
                                    <span>
                                      输入{" "}
                                      {formatProxyLogTokenValue(
                                        detailLog.promptTokens,
                                      )}{" "}
                                      tokens
                                      {" + "}输出{" "}
                                      {formatProxyLogTokenValue(
                                        detailLog.completionTokens,
                                      )}{" "}
                                      tokens
                                      {" = "}总计{" "}
                                      {formatProxyLogTokenValue(
                                        detailLog.totalTokens,
                                      )}{" "}
                                      tokens
                                      {typeof detailLog.estimatedCost ===
                                        "number" && (
                                        <>
                                          ，预估费用{" "}
                                          <strong
                                            style={{
                                              color:
                                                "var(--color-text-primary)",
                                            }}
                                          >
                                            $
                                            {detailLog.estimatedCost.toFixed(6)}
                                          </strong>
                                        </>
                                      )}
                                    </span>
                                  )}
                                </div>

                                <div
                                  style={{
                                    display: "flex",
                                    gap: 6,
                                    alignItems: "center",
                                  }}
                                >
                                  <span
                                    style={{
                                      fontWeight: 600,
                                      color: "var(--color-primary)",
                                      flexShrink: 0,
                                    }}
                                  >
                                    下游请求路径
                                  </span>
                                  {detail && pathMeta.downstreamPath ? (
                                    <code
                                      style={{
                                        fontFamily: "var(--font-mono)",
                                        fontSize: 12,
                                        background: "var(--color-bg-card)",
                                        padding: "1px 8px",
                                        borderRadius: 4,
                                        border:
                                          "1px solid var(--color-border-light)",
                                      }}
                                    >
                                      {pathMeta.downstreamPath}
                                    </code>
                                  ) : (
                                    <span
                                      style={{
                                        color: "var(--color-text-muted)",
                                      }}
                                    >
                                      未记录
                                    </span>
                                  )}
                                </div>

                                <div
                                  style={{
                                    display: "flex",
                                    gap: 6,
                                    alignItems: "center",
                                  }}
                                >
                                  <span
                                    style={{
                                      fontWeight: 600,
                                      color: "var(--color-primary)",
                                      flexShrink: 0,
                                    }}
                                  >
                                    上游请求路径
                                  </span>
                                  {detail && pathMeta.upstreamPath ? (
                                    <code
                                      style={{
                                        fontFamily: "var(--font-mono)",
                                        fontSize: 12,
                                        background: "var(--color-bg-card)",
                                        padding: "1px 8px",
                                        borderRadius: 4,
                                        border:
                                          "1px solid var(--color-border-light)",
                                      }}
                                    >
                                      {pathMeta.upstreamPath}
                                    </code>
                                  ) : (
                                    <span
                                      style={{
                                        color: "var(--color-text-muted)",
                                      }}
                                    >
                                      未记录
                                    </span>
                                  )}
                                </div>

                                {detail &&
                                  pathMeta.errorMessage.trim().length > 0 && (
                                    <div style={{ display: "flex", gap: 6 }}>
                                      <span
                                        style={{
                                          fontWeight: 600,
                                          color: "var(--color-danger)",
                                          flexShrink: 0,
                                        }}
                                      >
                                        错误信息
                                      </span>
                                      <span
                                        style={{
                                          color: "var(--color-danger)",
                                          whiteSpace: "pre-wrap",
                                        }}
                                      >
                                        {pathMeta.errorMessage}
                                      </span>
                                    </div>
                                  )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {!loading && logs.length === 0 && (
          <div className="empty-state">
            <svg
              className="empty-state-icon"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            <div className="empty-state-title">{tr("暂无使用日志")}</div>
            <div className="empty-state-desc">
              当请求通过代理时，日志将显示在这里
            </div>
          </div>
        )}
      </div>

      {total > 0 && (
        <div className="pagination">
          <div
            style={{
              fontSize: 12,
              color: "var(--color-text-muted)",
              marginRight: "auto",
            }}
          >
            显示第 {displayedStart} - {displayedEnd} 条，共 {total} 条
          </div>
          <button
            className="pagination-btn"
            disabled={safePage <= 1}
            onClick={() => setPage((current) => current - 1)}
          >
            <svg
              width="14"
              height="14"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          {pageNumbers.map((num) => (
            <button
              key={num}
              className={`pagination-btn ${safePage === num ? "active" : ""}`}
              onClick={() => setPage(num)}
            >
              {num}
            </button>
          ))}
          <button
            className="pagination-btn"
            disabled={safePage >= totalPages}
            onClick={() => setPage((current) => current + 1)}
          >
            <svg
              width="14"
              height="14"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>
          <div className="pagination-size">
            每页条数:
            <div style={{ minWidth: 86 }}>
              <ModernSelect
                size="sm"
                value={String(pageSize)}
                onChange={(nextValue) => {
                  setPageSize(Number(nextValue));
                  setPage(1);
                }}
                options={PAGE_SIZES.map((s) => ({
                  value: String(s),
                  label: String(s),
                }))}
                placeholder={String(pageSize)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
