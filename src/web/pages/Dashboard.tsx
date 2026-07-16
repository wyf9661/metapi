import { Suspense, lazy, useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.js";
import { useIsMobile } from "../components/useIsMobile.js";
import { formatCompactTokenMetric } from "../numberFormat.js";

const ModelAnalysisPanel = lazy(
  () => import("../components/ModelAnalysisPanel.js"),
);
const SiteDistributionChart = lazy(
  () => import("../components/charts/SiteDistributionChart.js"),
);
const SiteTrendChart = lazy(
  () => import("../components/charts/SiteTrendChart.js"),
);

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "🌙 夜深了";
  if (hour < 11) return "☀️ 早上好";
  if (hour < 13) return "👋 中午好";
  if (hour < 18) return "🌤️ 下午好";
  return "🌙 晚上好";
}

function safeNumber(value: unknown): number {
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    !Number.isFinite(value)
  )
    return 0;
  return value;
}

function ChartFallback({ height = 280 }: { height?: number }) {
  return (
    <div className="card" style={{ minHeight: height, padding: 16 }}>
      <div
        className="skeleton"
        style={{ width: 160, height: 18, marginBottom: 12 }}
      />
      <div
        className="skeleton"
        style={{
          width: "100%",
          height: Math.max(120, height - 46),
          borderRadius: 10,
        }}
      />
    </div>
  );
}

type SiteSpeedState =
  | { status: "loading" }
  | { status: "timeout" }
  | { status: "done"; ms: number }
  | undefined;

type SiteAvailabilityBucket = {
  startUtc?: string | null;
  label: string;
  totalRequests: number;
  successCount: number;
  failedCount: number;
  availabilityPercent: number | null;
  averageLatencyMs: number | null;
};

type SiteAvailabilitySummary = {
  siteId: number;
  siteName: string;
  siteUrl?: string | null;
  platform?: string | null;
  totalRequests: number;
  successCount: number;
  failedCount: number;
  availabilityPercent: number | null;
  averageLatencyMs: number | null;
  buckets: SiteAvailabilityBucket[];
};

function formatAvailabilityPercent(value: number | null | undefined): string {
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    !Number.isFinite(value)
  )
    return "—";
  return `${Math.round(value)}%`;
}

function getAvailabilityColor(value: number | null | undefined): string {
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    !Number.isFinite(value)
  ) {
    return "var(--color-border-light)";
  }
  const clamped = Math.max(0, Math.min(100, value));
  const low = { r: 229, g: 80, b: 69 }; // 鲜亮红
  const mid = { r: 217, g: 161, b: 37 }; // 鲜亮黄
  const high = { r: 82, g: 196, b: 26 }; // 鲜亮绿

  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

  let r: number;
  let g: number;
  let b: number;

  if (clamped <= 50) {
    const t = clamped / 50;
    r = lerp(low.r, mid.r, t);
    g = lerp(low.g, mid.g, t);
    b = lerp(low.b, mid.b, t);
  } else {
    const t = (clamped - 50) / 50;
    r = lerp(mid.r, high.r, t);
    g = lerp(mid.g, high.g, t);
    b = lerp(mid.b, high.b, t);
  }

  return `rgb(${r}, ${g}, ${b})`;
}

function padDateTimeSegment(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateTimeRouteValue(value: Date): string {
  return `${value.getFullYear()}-${padDateTimeSegment(value.getMonth() + 1)}-${padDateTimeSegment(value.getDate())}T${padDateTimeSegment(value.getHours())}:${padDateTimeSegment(value.getMinutes())}`;
}

function buildSiteLogsRoute(
  siteId: number,
  range?: { from: Date; to: Date },
): string {
  const params = new URLSearchParams();
  params.set("siteId", String(siteId));
  if (range) {
    params.set("from", formatDateTimeRouteValue(range.from));
    params.set("to", formatDateTimeRouteValue(range.to));
  }
  return `/logs?${params.toString()}`;
}

function buildSiteLast24hLogsRoute(siteId: number): string {
  const now = new Date();
  const from = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours() - 23,
    0,
    0,
    0,
  );
  const to = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours() + 1,
    0,
    0,
    0,
  );
  return buildSiteLogsRoute(siteId, { from, to });
}

function parseAvailabilityBucketStart(startUtc?: string | null): Date | null {
  const text = (startUtc || "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseAvailabilityBucketLabel(label: string): Date | null {
  const match = label.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0"] = match;
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    0,
  );
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatAvailabilityBucketLabel(bucket: SiteAvailabilityBucket): string {
  const parsed =
    parseAvailabilityBucketStart(bucket.startUtc) ||
    parseAvailabilityBucketLabel(bucket.label);
  if (!parsed) return bucket.label;
  return `${parsed.getFullYear()}-${padDateTimeSegment(parsed.getMonth() + 1)}-${padDateTimeSegment(parsed.getDate())} ${padDateTimeSegment(parsed.getHours())}:${padDateTimeSegment(parsed.getMinutes())}:${padDateTimeSegment(parsed.getSeconds())}`;
}

function buildAvailabilityBucketLogsRoute(
  siteId: number,
  bucket: SiteAvailabilityBucket,
): string {
  const start =
    parseAvailabilityBucketStart(bucket.startUtc) ||
    parseAvailabilityBucketLabel(bucket.label);
  if (!start) return buildSiteLast24hLogsRoute(siteId);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return buildSiteLogsRoute(siteId, { from: start, to: end });
}

export default function Dashboard({
  adminName = "\u7ba1\u7406\u5458",
}: {
  adminName?: string;
}) {
  const isMobile = useIsMobile();
  const [data, setData] = useState<any>(null);
  const [insightsData, setInsightsData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tunnel, setTunnel] = useState<any>(null);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const isTunnelClientView = typeof window !== 'undefined'
    && (
      window.location.hostname.endsWith('.trycloudflare.com')
      || window.location.hostname.endsWith('.abc-tunnel.us')
    );

  const [insightsLoading, setInsightsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [siteDistribution, setSiteDistribution] = useState<any[]>([]);
  const [siteTrend, setSiteTrend] = useState<any[]>([]);
  const [siteLoading, setSiteLoading] = useState(true);
  const [sites, setSites] = useState<any[]>([]);
  const [siteSpeedStates, setSiteSpeedStates] = useState<
    Record<string, SiteSpeedState>
  >({});
  const [trendDays, setTrendDays] = useState(7);
  const [showInactiveSites, setShowInactiveSites] = useState(false);
  const toast = useToast();
  const normalizedAdminName = (adminName || "").trim() || "\u7ba1\u7406\u5458";

  const getSiteSpeedKey = (site: any, idx: number) => String(site?.id ?? idx);

  const setSiteSpeedState = (siteKey: string, nextState: SiteSpeedState) => {
    setSiteSpeedStates((current) => ({ ...current, [siteKey]: nextState }));
  };

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const result = await api.getDashboardSnapshot(
          silent ? { refresh: true } : undefined,
        );
        setData(result);
      } catch (err: any) {
        const message = err?.message || "加载仪表盘失败";
        setError(message);
        if (silent) toast.error(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [toast],
  );

  const loadInsights = useCallback(async (forceRefresh = false) => {
    setInsightsLoading(true);
    try {
      const result = await api.getDashboardInsights(
        forceRefresh ? { refresh: true } : undefined,
      );
      setInsightsData(result);
    } catch (err) {
      console.error("Failed to load dashboard insights:", err);
    } finally {
      setInsightsLoading(false);
    }
  }, []);

  const loadSiteStats = useCallback(
    async (forceRefresh = false) => {
      setSiteLoading(true);
      try {
        const snapshot = await api.getSiteSnapshot(
          trendDays,
          forceRefresh ? { refresh: true } : undefined,
        );
        setSiteDistribution(snapshot.distribution || []);
        setSiteTrend(snapshot.trend || []);
        const siteRows = Array.isArray(snapshot.sites) ? snapshot.sites : [];
        setSites(siteRows.filter((site: any) => site?.status !== "disabled"));
        setSiteSpeedStates({});
      } catch (err) {
        console.error("Failed to load site stats:", err);
      } finally {
        setSiteLoading(false);
      }
    },
    [trendDays],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    void loadInsights();
  }, [loadInsights]);

  useEffect(() => {
    loadSiteStats();
  }, [loadSiteStats]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const pollDashboard = async () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      )
        return;
      try {
        const next = await api.getDashboardSnapshot();
        if (!disposed) setData(next);
      } catch {
        // ignore polling errors
      }
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        void pollDashboard();
      }, 30000);
    };

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const handleVisibilityChange = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        void pollDashboard();
        start();
      } else {
        stop();
      }
    };

    handleVisibilityChange();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      disposed = true;
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      }
    };
  }, []);


  const refreshTunnel = useCallback(async () => {
    try {
      const res = await api.getTunnelStatus() as any;
      setTunnel(res?.tunnel || res || null);
      setTunnelError(null);
    } catch (err: any) {
      setTunnelError(err?.message || '加载隧道状态失败');
    }
  }, []);

  useEffect(() => {
    void refreshTunnel();
    const timer = window.setInterval(() => {
      void refreshTunnel();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [refreshTunnel]);

  const handleToggleDashboardAccess = async (next: boolean) => {
    if (isTunnelClientView) {
      toast.error('通过公网隧道时不允许修改该选项，请在本机控制台操作');
      return;
    }
    const prev = !!tunnel?.dashboardAccess;
    setTunnel((current: any) => ({ ...(current || {}), dashboardAccess: next }));
    try {
      const res = await api.setTunnelDashboardAccess(next) as any;
      setTunnel(res?.tunnel || { ...(tunnel || {}), dashboardAccess: next });
      toast.success(next ? '已允许隧道访问控制台' : '已限制隧道仅 API 访问');
    } catch (err: any) {
      setTunnel((current: any) => ({ ...(current || {}), dashboardAccess: prev }));
      toast.error(err?.message || '更新失败');
    }
  };

  const handleToggleTunnel = async () => {
    if (isTunnelClientView) {
      toast.error('通过公网隧道时不允许关闭/创建隧道，请在本机控制台操作');
      return;
    }
    setTunnelBusy(true);
    setTunnelError(null);
    try {
      if (tunnel?.running || tunnel?.enabled) {
        const res = await api.disableTunnel() as any;
        setTunnel(res?.tunnel || null);
        toast.success('隧道已关闭');
      } else {
        toast.info('正在创建公网隧道，首次可能需要下载 cloudflared...');
        const res = await api.enableTunnel() as any;
        setTunnel(res?.tunnel || null);
        if (res?.tunnel?.publicUrl || res?.tunnel?.tunnelUrl) {
          toast.success('隧道已启用');
        } else {
          toast.info(res?.message || '隧道启动中');
        }
      }
      await refreshTunnel();
    } catch (err: any) {
      setTunnelError(err?.message || '隧道操作失败');
      toast.error(err?.message || '隧道操作失败');
      await refreshTunnel();
    } finally {
      setTunnelBusy(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="animate-fade-in">
        <div
          className="skeleton"
          style={{
            width: 280,
            height: 32,
            marginBottom: 24,
            borderRadius: "var(--radius-sm)",
          }}
        />
        <div className="dashboard-stat-grid">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className={`stat-card animate-slide-up stagger-${i + 1}`}
            >
              <div
                className="skeleton"
                style={{ width: 80, height: 14, marginBottom: 16 }}
              />
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    className="skeleton"
                    style={{ width: 36, height: 36, borderRadius: "50%" }}
                  />
                  <div>
                    <div
                      className="skeleton"
                      style={{ width: 60, height: 10, marginBottom: 6 }}
                    />
                    <div
                      className="skeleton"
                      style={{ width: 80, height: 20 }}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    className="skeleton"
                    style={{ width: 36, height: 36, borderRadius: "50%" }}
                  />
                  <div>
                    <div
                      className="skeleton"
                      style={{ width: 60, height: 10, marginBottom: 6 }}
                    />
                    <div
                      className="skeleton"
                      style={{ width: 80, height: 20 }}
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="animate-fade-in">
        <h2 className="greeting" style={{ marginBottom: 24 }}>
          {getGreeting() + "\uFF0C" + normalizedAdminName}
        </h2>
        <div className="card" style={{ padding: 48, textAlign: "center" }}>
          <div
            style={{
              width: 48,
              height: 48,
              background: "var(--color-danger-soft)",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 12px",
            }}
          >
            <svg
              width="24"
              height="24"
              fill="none"
              viewBox="0 0 24 24"
              stroke="var(--color-danger)"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
          </div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>加载失败</div>
          <div
            style={{
              fontSize: 13,
              color: "var(--color-text-muted)",
              marginBottom: 16,
            }}
          >
            {error}
          </div>
          <button onClick={() => load()} className="btn btn-soft-primary">
            重试
          </button>
        </div>
      </div>
    );
  }

  const totalBalance = safeNumber(data?.totalBalance);
  const totalUsed = safeNumber(data?.totalUsed || 0);
  const todaySpend = safeNumber(data?.todaySpend || 0);
  const todayReward = safeNumber(data?.todayReward || 0);
  const activeAccounts = safeNumber(data?.activeAccounts);
  const totalAccounts = safeNumber(data?.totalAccounts);
  const todaySuccess = safeNumber(data?.todayCheckin?.success);
  const todayTotal = safeNumber(data?.todayCheckin?.total);
  const proxy24hSuccess = safeNumber(data?.proxy24h?.success);
  const proxy24hTotal = safeNumber(data?.proxy24h?.total);
  const totalTokens = safeNumber(data?.proxy24h?.totalTokens);
  const performanceWindowSeconds = Math.max(
    1,
    safeNumber(data?.performance?.windowSeconds) || 60,
  );
  const requestsPerMinute = safeNumber(data?.performance?.requestsPerMinute);
  const tokensPerMinute = safeNumber(data?.performance?.tokensPerMinute);
  const rawSiteAvailability: SiteAvailabilitySummary[] = Array.isArray(
    insightsData?.siteAvailability,
  )
    ? insightsData.siteAvailability
    : [];
  const activeSites = rawSiteAvailability
    .filter((s) => s.totalRequests > 0)
    .sort((a, b) => (b.totalRequests || 0) - (a.totalRequests || 0));
  const inactiveSites = rawSiteAvailability.filter(
    (s) => !s.totalRequests || s.totalRequests === 0,
  );
  const siteAvailability = showInactiveSites
    ? [...activeSites, ...inactiveSites]
    : activeSites;

  const getLatencyColor = (ms: number) =>
    ms <= 500
      ? "var(--color-success)"
      : ms <= 1000
        ? "color-mix(in srgb, var(--color-success) 60%, var(--color-warning))"
        : ms <= 1500
          ? "var(--color-warning)"
          : ms <= 2000
            ? "color-mix(in srgb, var(--color-warning) 60%, var(--color-danger))"
            : ms < 3000
              ? "color-mix(in srgb, var(--color-warning) 30%, var(--color-danger))"
              : "var(--color-danger)";

  const formatDashboardLatency = (ms: number | null | undefined) => {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
    if (ms >= 1000) {
      const seconds = ms / 1000;
      if (seconds >= 10) return `${Math.round(seconds)}s`;
      return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
    }
    return `${Math.round(ms)}ms`;
  };

  const renderSiteSpeedLabel = (site: any, idx: number) => {
    const siteKey = getSiteSpeedKey(site, idx);
    const speedState = siteSpeedStates[siteKey];

    if (!speedState || speedState.status === "loading") {
      return speedState ? "..." : "测速";
    }

    if (speedState.status === "timeout") {
      return "超时";
    }

    const ms = speedState.ms;
    const color = getLatencyColor(ms);

    return (
      <>
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            boxShadow: `0 0 4px ${color}`,
            animation: "pulse 1.5s ease-in-out infinite",
            marginRight: 3,
            verticalAlign: "middle",
          }}
        />
        <span style={{ color, fontWeight: 600 }}>{formatDashboardLatency(ms)}</span>
      </>
    );
  };

  return (
    <div className="animate-fade-in">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <h2 className="greeting">
          {getGreeting() + "\uFF0C" + normalizedAdminName}
        </h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => {
              void load(true);
              void loadInsights(true);
              void loadSiteStats(true);
            }}
            disabled={refreshing}
            className="topbar-icon-btn"
            data-tooltip="刷新"
            aria-label="刷新"
          >
            <svg
              width="18"
              height="18"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              style={{
                animation: refreshing ? "spin 1s linear infinite" : "none",
              }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </div>
      </div>

      
      <div className="card" style={{ padding: 16, marginBottom: 16, border: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: '1 1 280px' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>公网隧道</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
              基于 Cloudflare Quick Tunnel，无需公网 IP / 端口映射。默认仅暴露 API；可在设置中允许访问控制台。
            </div>
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <span className={`badge ${(tunnel?.running || tunnel?.enabled) ? 'badge-success' : 'badge-muted'}`} style={{ fontSize: 11, fontWeight: 700 }}>
                {(tunnel?.running || tunnel?.enabled) ? '运行中' : '未启用'}
              </span>
              <span className={`badge ${tunnel?.dashboardAccess ? 'badge-info' : 'badge-muted'}`} style={{ fontSize: 11, fontWeight: 600 }}>
                {tunnel?.dashboardAccess ? '控制台+API' : '仅 API'}
              </span>
              {tunnel?.downloading ? (
                <span className="badge badge-warning" style={{ fontSize: 11 }}>
                  下载 cloudflared{typeof tunnel?.downloadProgress === 'number' ? ` ${tunnel.downloadProgress}%` : '...'}
                </span>
              ) : null}
            </div>
            <label style={{
              marginTop: 12,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg)',
              cursor: 'pointer',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  允许通过隧道访问控制台
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, lineHeight: 1.45 }}>
                  {isTunnelClientView
                    ? '当前正通过公网隧道访问，无法修改此选项。请在本机/内网控制台切换。'
                    : '关闭=公网只走 API（/v1/*）；开启=可用隧道 URL 打开控制页（仍需管理员登录）'}
                </div>
              </div>
              <input
                type="checkbox"
                checked={!!tunnel?.dashboardAccess}
                disabled={isTunnelClientView}
                onChange={(e) => { void handleToggleDashboardAccess(e.target.checked); }}
                style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
              />
            </label>
            {(tunnel?.publicUrl || tunnel?.tunnelUrl) ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>公网地址</div>
                <code style={{
                  display: 'block',
                  padding: '10px 12px',
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: 'var(--color-text-primary)',
                  wordBreak: 'break-all',
                }}>
                  {tunnel?.publicUrl || tunnel?.tunnelUrl}
                </code>
              </div>
            ) : null}
            {tunnelError || tunnel?.lastError ? (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-danger)' }}>
                {tunnelError || tunnel?.lastError}
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
            {(tunnel?.publicUrl || tunnel?.tunnelUrl) ? (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)', padding: '8px 12px' }}
                onClick={async () => {
                  const url = String(tunnel?.publicUrl || tunnel?.tunnelUrl || '');
                  try {
                    await navigator.clipboard.writeText(url);
                    toast.success('已复制公网地址');
                  } catch {
                    toast.error('复制失败');
                  }
                }}
              >
                复制地址
              </button>
            ) : null}
            {!isTunnelClientView ? (
              <button
                type="button"
                className={`btn ${(tunnel?.running || tunnel?.enabled) ? 'btn-ghost' : 'btn-primary'}`}
                style={{ border: '1px solid var(--color-border)', padding: '8px 12px', minWidth: 108 }}
                disabled={tunnelBusy}
                onClick={() => { void handleToggleTunnel(); }}
              >
                {tunnelBusy ? '处理中...' : ((tunnel?.running || tunnel?.enabled) ? '关闭隧道' : '创建隧道')}
              </button>
            ) : (
              <span className="badge badge-warning" style={{ fontSize: 11, fontWeight: 600 }}>
                隧道访问中：不可关闭隧道
              </span>
            )}
          </div>
        </div>
      </div>

<div className="dashboard-stat-grid">
        <div className="stat-card animate-slide-up stagger-1">
          <div className="stat-card-header">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
              />
            </svg>
            账户数据
          </div>
          <div className="stat-card-row">
            <div className="stat-icon stat-icon-blue">
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <div className="dashboard-stat-content">
              <div className="stat-label">当前余额</div>
              <div className="stat-value animate-count-up">
                ${totalBalance.toFixed(2)}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color:
                    todayReward > 0
                      ? "var(--color-success)"
                      : "var(--color-text-muted)",
                  fontWeight: 500,
                  marginTop: 2,
                }}
              >
                今日 +{todayReward.toFixed(2)}
              </div>
            </div>
          </div>
          <div className="stat-card-row">
            <div className="stat-icon stat-icon-green">
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                />
              </svg>
            </div>
            <div className="dashboard-stat-content">
              <div className="stat-label">累计消耗</div>
              <div className="stat-value animate-count-up">
                ${totalUsed.toFixed(2)}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color:
                    todaySpend > 0
                      ? "var(--color-danger)"
                      : "var(--color-text-muted)",
                  fontWeight: 500,
                  marginTop: 2,
                }}
              >
                今日 -{todaySpend.toFixed(2)}
              </div>
            </div>
          </div>
        </div>

        <div className="stat-card animate-slide-up stagger-2">
          <div className="stat-card-header">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            使用统计
          </div>
          <div className="stat-card-row">
            <div className="stat-icon stat-icon-yellow">
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
            <div className="dashboard-stat-content">
              <div className="stat-label">24h 请求</div>
              <div className="stat-value animate-count-up">
                {Math.round(proxy24hTotal).toLocaleString()}
              </div>
            </div>
          </div>
          <div className="stat-card-row">
            <div className="stat-icon stat-icon-cyan">
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"
                />
              </svg>
            </div>
            <div className="dashboard-stat-content">
              <div className="stat-label">成功请求</div>
              <div className="stat-value animate-count-up">
                {Math.round(proxy24hSuccess).toLocaleString()}
              </div>
            </div>
          </div>
        </div>

        <div className="stat-card animate-slide-up stagger-3">
          <div className="stat-card-header">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
            资源消耗
          </div>
          <div className="stat-card-row">
            <div className="stat-icon stat-icon-pink">
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </div>
            <div className="dashboard-stat-content">
              <div className="stat-label">活跃账户</div>
              <div className="stat-value animate-count-up">
                {Math.round(activeAccounts)}/{Math.round(totalAccounts)}
              </div>
            </div>
          </div>
          <div className="stat-card-row">
            <div className="stat-icon stat-icon-red">
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
                />
              </svg>
            </div>
            <div className="dashboard-stat-content">
              <div className="stat-label">24h Tokens</div>
              <div className="stat-value animate-count-up">
                {formatCompactTokenMetric(totalTokens)}
              </div>
            </div>
          </div>
        </div>

        <div className="stat-card animate-slide-up stagger-4">
          <div className="stat-card-header">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
            签到状态
          </div>
          <div className="stat-card-row">
            <div className="stat-icon stat-icon-purple">
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <div className="dashboard-stat-content">
              <div className="stat-label">今日签到</div>
              <div className="stat-value animate-count-up">
                {Math.round(todaySuccess)}/{Math.round(todayTotal)}
              </div>
            </div>
          </div>
          <div className="stat-card-row">
            <div className="stat-icon stat-icon-orange">
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <div className="dashboard-stat-content">
              <div className="stat-label">成功率</div>
              <div className="stat-value animate-count-up">
                {todayTotal > 0
                  ? Math.round((todaySuccess / todayTotal) * 100)
                  : 0}
                %
              </div>
            </div>
          </div>
        </div>

        <div className="stat-card animate-slide-up stagger-5">
          <div className="stat-card-header">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 3v10h8M5 12h3m-3 4h6m-6 4h10a2 2 0 002-2V8.828a2 2 0 00-.586-1.414l-4.828-4.828A2 2 0 0010.172 2H5a2 2 0 00-2 2v14a2 2 0 002 2z"
              />
            </svg>
            性能指标
          </div>
          <div className="stat-card-row">
            <div className="stat-icon stat-icon-blue">
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 13h4v7H4zm6-9h4v16h-4zm6 5h4v11h-4z"
                />
              </svg>
            </div>
            <div className="dashboard-stat-content">
              <div className="stat-label">RPM</div>
              <div className="stat-value animate-count-up">
                {Math.round(requestsPerMinute).toLocaleString()}
              </div>
              <div className="dashboard-stat-note">
                最近 {performanceWindowSeconds} 秒请求
              </div>
            </div>
          </div>
          <div className="stat-card-row">
            <div className="stat-icon stat-icon-cyan">
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4m13-5l3 3-3 3M8 7L5 10l3 3"
                />
              </svg>
            </div>
            <div className="dashboard-stat-content">
              <div className="stat-label">TPM</div>
              <div className="stat-value animate-count-up">
                {formatCompactTokenMetric(tokensPerMinute)}
              </div>
              <div className="dashboard-stat-note">
                最近 {performanceWindowSeconds} 秒 Tokens
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 站点级分析 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          marginTop: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 14,
            fontWeight: 600,
            color: "var(--color-text-primary)",
          }}
        >
          <svg
            width="16"
            height="16"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
            />
          </svg>
          站点分析
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setTrendDays(d)}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                border: "none",
                cursor: "pointer",
                background:
                  trendDays === d ? "var(--color-primary)" : "var(--color-bg)",
                color:
                  trendDays === d ? "white" : "var(--color-text-secondary)",
                transition: "all 0.2s ease",
              }}
            >
              {d}天
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <div className="chart-panel-enter animate-slide-up stagger-6">
          <Suspense fallback={<ChartFallback height={320} />}>
            <SiteDistributionChart
              data={siteDistribution}
              loading={siteLoading}
            />
          </Suspense>
        </div>
        <div className="chart-panel-enter animate-slide-up stagger-7">
          <Suspense fallback={<ChartFallback height={320} />}>
            <SiteTrendChart data={siteTrend} loading={siteLoading} />
          </Suspense>
        </div>
      </div>

      <div className="chart-container animate-slide-up stagger-8 site-observability-panel">
        <div className="site-observability-header">
          <div>
            <div className="site-observability-title">
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 12h4l3 8 4-16 3 8h4"
                />
              </svg>
              站点可用性观测
              <span className="site-observability-count-badge">
                {activeSites.length}/{rawSiteAvailability.length}
              </span>
            </div>
            <div className="site-observability-subtitle">
              最近 24 小时 · 每色块 = 1h · 按使用量排序
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="site-observability-legend">
              <span className="site-observability-legend-text">低</span>
              <span
                className="site-observability-legend-chip"
                style={{ background: getAvailabilityColor(0) }}
              />
              <span
                className="site-observability-legend-chip"
                style={{ background: getAvailabilityColor(50) }}
              />
              <span
                className="site-observability-legend-chip"
                style={{ background: getAvailabilityColor(100) }}
              />
              <span className="site-observability-legend-text">高</span>
            </div>
            {inactiveSites.length > 0 && (
              <button
                className="site-observability-toggle-btn"
                onClick={() => setShowInactiveSites((v) => !v)}
              >
                {showInactiveSites
                  ? "隐藏未使用"
                  : `显示未使用 (${inactiveSites.length})`}
              </button>
            )}
          </div>
        </div>

        {insightsLoading && rawSiteAvailability.length === 0 ? (
          <div style={{ display: "grid", gap: 12 }}>
            {[...Array(4)].map((_, index) => (
              <div
                key={index}
                className="card"
                style={{ minHeight: 88, padding: 16 }}
              >
                <div
                  className="skeleton"
                  style={{ width: 160, height: 14, marginBottom: 10 }}
                />
                <div
                  className="skeleton"
                  style={{ width: "100%", height: 12, marginBottom: 8 }}
                />
                <div
                  className="skeleton"
                  style={{ width: "100%", height: 18, borderRadius: 8 }}
                />
              </div>
            ))}
          </div>
        ) : siteAvailability.length > 0 ? (
          <div className="site-observability-grid">
            {siteAvailability.map((site) => (
              <div
                key={site.siteId}
                className={`site-observability-card${site.totalRequests > 0 ? "" : " site-observability-card--inactive"}`}
              >
                <div className="site-observability-card-top">
                  <div className="site-observability-card-title">
                    <span className="site-observability-site-name">
                      {site.siteName}
                    </span>
                    {site.platform && (
                      <span className="site-observability-platform-badge">
                        {site.platform}
                      </span>
                    )}
                  </div>
                  <Link
                    to={buildSiteLast24hLogsRoute(site.siteId)}
                    className="site-observability-log-link-compact"
                    title="查看日志"
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
                  </Link>
                </div>
                <div className="site-observability-card-metrics">
                  <span
                    className="site-observability-metric-main"
                    style={{
                      color: getAvailabilityColor(site.availabilityPercent),
                    }}
                  >
                    {formatAvailabilityPercent(site.availabilityPercent)}
                  </span>
                  <span className="site-observability-metric-sep">·</span>
                  <span
                    style={
                      site.averageLatencyMs != null
                        ? { color: getLatencyColor(site.averageLatencyMs) }
                        : undefined
                    }
                  >
                    {site.averageLatencyMs != null
                      ? formatDashboardLatency(site.averageLatencyMs)
                      : "—"}
                  </span>
                  <span className="site-observability-metric-sep">·</span>
                  <span>{Math.round(site.totalRequests || 0)} 次</span>
                </div>
                <div className="site-availability-strip-compact">
                  {site.buckets.map((bucket, index) => (
                    <Link
                      key={`${site.siteId}-${index}`}
                      to={buildAvailabilityBucketLogsRoute(site.siteId, bucket)}
                      className="site-availability-cell site-availability-cell-link site-availability-cell-pill"
                      style={{
                        background: getAvailabilityColor(
                          bucket.availabilityPercent,
                        ),
                        opacity: bucket.totalRequests > 0 ? 1 : 0.3,
                      }}
                      data-tooltip={[
                        `时间：${formatAvailabilityBucketLabel(bucket)}`,
                        bucket.totalRequests > 0
                          ? `可用性：${formatAvailabilityPercent(bucket.availabilityPercent)}`
                          : "可用性：无请求",
                        `请求：${bucket.totalRequests} 次`,
                        `成功/失败：${bucket.successCount}/${bucket.failedCount}`,
                        bucket.averageLatencyMs != null
                          ? `平均响应：${formatDashboardLatency(bucket.averageLatencyMs)}`
                          : "平均响应：—",
                      ].join(" · ")}
                      data-tooltip-align="start"
                      title={[
                        formatAvailabilityBucketLabel(bucket),
                        bucket.totalRequests > 0
                          ? `可用性 ${formatAvailabilityPercent(bucket.availabilityPercent)}`
                          : "无请求",
                        `${bucket.successCount} 成功 / ${bucket.failedCount} 失败`,
                        bucket.averageLatencyMs != null
                          ? `平均响应 ${formatDashboardLatency(bucket.averageLatencyMs)}`
                          : "平均响应 —",
                      ].join(" | ")}
                      aria-label={`${site.siteName} ${formatAvailabilityBucketLabel(bucket)} 使用日志`}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="site-observability-empty">
            <div className="site-observability-empty-title">
              暂无站点观测数据
            </div>
            <div className="site-observability-empty-note">
              有代理请求后，这里会自动生成每个站点的可用性条和平均响应速度。
            </div>
          </div>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "1fr 300px",
          gap: 16,
        }}
      >
        <div className="chart-container animate-slide-up stagger-8">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 14,
                fontWeight: 600,
                color: "var(--color-text-primary)",
              }}
            >
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              模型数据分析
            </div>
          </div>
          {insightsLoading && !insightsData ? (
            <ChartFallback height={260} />
          ) : (
            <Suspense fallback={<ChartFallback height={260} />}>
              <ModelAnalysisPanel data={insightsData?.modelAnalysis} />
            </Suspense>
          )}
        </div>

        <div
          className="chart-container animate-slide-up stagger-9"
          style={{ display: "flex", flexDirection: "column" }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              color: "var(--color-text-primary)",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <svg
                width="16"
                height="16"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"
                />
              </svg>
              站点信息
            </span>
            {sites.length > 0 && (
              <button
                className="btn btn-ghost"
                style={{
                  fontSize: 11,
                  padding: "3px 10px",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
                onClick={async () => {
                  await Promise.all(
                    sites.map(async (s: any, idx: number) => {
                      const siteKey = getSiteSpeedKey(s, idx);
                      setSiteSpeedState(siteKey, { status: "loading" });
                      try {
                        const start = performance.now();
                        await fetch(`${s.url}/v1/models`, {
                          method: "GET",
                          mode: "no-cors",
                        });
                        const ms = Math.round(performance.now() - start);
                        setSiteSpeedState(siteKey, { status: "done", ms });
                      } catch {
                        setSiteSpeedState(siteKey, { status: "timeout" });
                      }
                    }),
                  );
                  toast.success("全部测速完成");
                }}
              >
                <svg
                  width="12"
                  height="12"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                一键测速
              </button>
            )}
          </div>
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {sites.length > 0 ? (
              sites.map((site: any, idx: number) => (
                <div
                  key={site.id || idx}
                  style={{
                    padding: "10px 12px",
                    border: "1px solid var(--color-border-light)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--color-bg)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 13 }}>
                      {site.name}
                    </span>
                    <button
                      className="btn btn-ghost"
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        border: "1px solid var(--color-border)",
                        borderRadius: 6,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                      }}
                      onClick={async () => {
                        const siteKey = getSiteSpeedKey(site, idx);
                        setSiteSpeedState(siteKey, { status: "loading" });
                        try {
                          const start = performance.now();
                          await fetch(`${site.url}/v1/models`, {
                            method: "GET",
                            mode: "no-cors",
                          });
                          const ms = Math.round(performance.now() - start);
                          setSiteSpeedState(siteKey, { status: "done", ms });
                          toast.success(`${site.name}: ${formatDashboardLatency(ms)}`);
                        } catch {
                          setSiteSpeedState(siteKey, { status: "timeout" });
                          toast.error(`${site.name}: 测速失败`);
                        }
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M13 10V3L4 14h7v7l9-11h-7z"
                        />
                      </svg>
                      <span>{renderSiteSpeedLabel(site, idx)}</span>
                    </button>
                    <a
                      href={site.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-ghost"
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        border: "1px solid var(--color-border)",
                        borderRadius: 6,
                        textDecoration: "none",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                        />
                      </svg>
                      跳转
                    </a>
                  </div>
                  <a
                    href={site.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 12,
                      color: "var(--color-info)",
                      wordBreak: "break-all",
                    }}
                  >
                    {site.url}
                  </a>
                </div>
              ))
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: 20,
                }}
              >
                <div style={{ width: 60, height: 60, opacity: 0.25 }}>
                  <svg
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="var(--color-text-muted)"
                    width="60"
                    height="60"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={0.6}
                      d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--color-text-secondary)",
                  }}
                >
                  代理端点可用
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--color-text-muted)",
                    textAlign: "center",
                    lineHeight: 1.6,
                  }}
                >
                  使用{" "}
                  <code
                    style={{
                      background: "var(--color-bg)",
                      padding: "2px 6px",
                      borderRadius: 4,
                      fontSize: 10,
                    }}
                  >
                    /v1/chat/completions
                  </code>{" "}
                  访问
                </div>
              </div>
            )}
            <div
              style={{
                marginTop: "auto",
                paddingTop: 8,
                borderTop: "1px solid var(--color-border-light)",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "var(--color-text-muted)",
                  marginBottom: 2,
                }}
              >
                24h 活跃调用
              </div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                {proxy24hTotal > 0
                  ? `${Math.round(proxy24hSuccess)}/${Math.round(proxy24hTotal)}`
                  : "—"}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
