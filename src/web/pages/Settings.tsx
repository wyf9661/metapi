import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { useIsMobile } from '../components/useIsMobile.js';
import ChangeKeyModal from '../components/ChangeKeyModal.js';
import { useAnimatedVisibility } from '../components/useAnimatedVisibility.js';
import ModernSelect from '../components/ModernSelect.js';
import ResponsiveFormGrid from '../components/ResponsiveFormGrid.js';
import FactoryResetModal from './settings/FactoryResetModal.js';
import {
  createCodexDefaultHighReasoningVisualPreset,
  createVisualPayloadRule,
  isVisualPayloadRuleBlank,
  payloadRulesToVisualRules,
  type PayloadRuleAction,
  type VisualPayloadRule,
  type VisualPayloadRuleValueMode,
  visualRulesToPayloadRules,
} from './settings/payloadRulesVisual.js';
import { PAYLOAD_RULE_PROTOCOL_OPTIONS } from './settings/payloadRuleProtocolOptions.js';
import UpdateCenterSection from './settings/UpdateCenterSection.js';
import {
  applyRoutingProfilePreset,
  resolveRoutingProfilePreset,
  type RoutingWeights,
} from './helpers/routingProfiles.js';
import { clearAuthSession } from '../authSession.js';
import { clearAppInstallationState } from '../appLocalState.js';
import {
  CHECKIN_INTERVAL_OPTIONS,
  CHECKIN_SCHEDULE_MODE_OPTIONS,
  PAYLOAD_RULES_EDITOR_SECTIONS,
  PAYLOAD_RULE_ACTION_OPTIONS,
  PAYLOAD_RULE_VALUE_MODE_OPTIONS,
  ROUTE_COOLDOWN_UNIT_OPTIONS,
  buildShorthandConnectionString,
  createEmptyPayloadRuleDrafts,
  defaultWeights,
  getDialectDefaults,
  inferUrlDialect,
  normalizePayloadRulesForEditor,
  parsePayloadRulesFromDrafts,
  resolveRouteCooldownInput,
  toRouteCooldownSeconds,
  type DbDialect,
  type PayloadRulesEditorDrafts,
  type RouteCooldownUnit,
  type ShorthandConnection,
} from './settings/settingsConfig.js';

const FACTORY_RESET_ADMIN_TOKEN = 'change-me-admin-token';
const FACTORY_RESET_CONFIRM_SECONDS = 3;
type SettingsPillTone = 'neutral' | 'primary' | 'danger' | 'warning';

type RuntimeSettings = {
  tunnelDashboardAccess?: boolean;
  tunnelEnabled?: boolean;
  checkinCron: string;
  checkinScheduleMode: 'cron' | 'interval';
  checkinIntervalHours: number;
  balanceRefreshCron: string;
  logCleanupCron: string;
  logCleanupUsageLogsEnabled: boolean;
  logCleanupProgramLogsEnabled: boolean;
  logCleanupRetentionDays: number;
  modelAvailabilityProbeEnabled: boolean;
  sensitiveWordDetectionEnabled: boolean;
  antiProbeMinTextLength: number;
  codexUpstreamWebsocketEnabled: boolean;
  responsesCompactFallbackToResponsesEnabled: boolean;
  disableCrossProtocolFallback: boolean;
  proxySessionChannelConcurrencyLimit: number;
  proxySessionChannelQueueWaitMs: number;
  routingFallbackUnitCost: number;
  proxyFirstByteTimeoutSec: number;
  proxyRouteProbeRate: number;
  routeFailureCooldownMaxValue: number;
  routeFailureCooldownMaxUnit: RouteCooldownUnit;
  routingWeights: RoutingWeights;
  defaultRoutingStrategy?: string;
  proxyErrorKeywords: string[];
  proxyEmptyContentFailEnabled: boolean;
  adminIpAllowlist?: string[];
  currentAdminIp?: string;
};


type DatabaseMigrationSummary = {
  dialect: DbDialect;
  connection: string;
  overwrite: boolean;
  version: string;
  timestamp: number;
  rows: {
    sites: number;
    accounts: number;
    accountTokens: number;
    tokenRoutes: number;
    routeChannels: number;
    settings: number;
  };
};

type RuntimeDatabaseState = {
  active: {
    dialect: DbDialect;
    connection: string;
    ssl: boolean;
  };
  saved: {
    dialect: DbDialect;
    connection: string;
    ssl: boolean;
  } | null;
  restartRequired: boolean;
};


export default function Settings() {
  const isMobile = useIsMobile();
  const isTunnelClientView = typeof window !== 'undefined'
    && (
      window.location.hostname.endsWith('.trycloudflare.com')
      || window.location.hostname.endsWith('.abc-tunnel.us')
    );
  const [runtime, setRuntime] = useState<RuntimeSettings>({
    tunnelDashboardAccess: false,
    tunnelEnabled: false,
    checkinCron: '0 8 * * *',
    checkinScheduleMode: 'cron',
    checkinIntervalHours: 6,
    balanceRefreshCron: '0 * * * *',
    logCleanupCron: '0 6 * * *',
    logCleanupUsageLogsEnabled: false,
    logCleanupProgramLogsEnabled: false,
    logCleanupRetentionDays: 30,
    modelAvailabilityProbeEnabled: false,
    sensitiveWordDetectionEnabled: true,
    antiProbeMinTextLength: 8,
    codexUpstreamWebsocketEnabled: false,
    responsesCompactFallbackToResponsesEnabled: false,
    disableCrossProtocolFallback: false,
    proxySessionChannelConcurrencyLimit: 2,
    proxySessionChannelQueueWaitMs: 1500,
    routingFallbackUnitCost: 1,
    proxyFirstByteTimeoutSec: 15,
    proxyRouteProbeRate: 0.15,
    routeFailureCooldownMaxValue: 30,
    routeFailureCooldownMaxUnit: 'day',
    routingWeights: defaultWeights,
    defaultRoutingStrategy: 'weighted',
    proxyErrorKeywords: [],
    proxyEmptyContentFailEnabled: false,
  });
  const [proxyErrorKeywordsText, setProxyErrorKeywordsText] = useState('');
  const [maskedToken, setMaskedToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [testingCheckin, setTestingCheckin] = useState(false);
  const [savingProxyTransport, setSavingProxyTransport] = useState(false);
  const [savingProxyFailureRules, setSavingProxyFailureRules] = useState(false);
  const [payloadVisualRules, setPayloadVisualRules] = useState<VisualPayloadRule[]>([]);
  const [payloadRuleDrafts, setPayloadRuleDrafts] = useState<PayloadRulesEditorDrafts>(createEmptyPayloadRuleDrafts());
  const [payloadAdvancedDirty, setPayloadAdvancedDirty] = useState(false);
  const [savingPayloadRules, setSavingPayloadRules] = useState(false);
  const [showPayloadRulesEditor, setShowPayloadRulesEditor] = useState(false);
  const [savingRouting, setSavingRouting] = useState(false);
  const [showAdvancedRouting, setShowAdvancedRouting] = useState(false);
  const [savingSecurity, setSavingSecurity] = useState(false);
  const [adminIpAllowlistText, setAdminIpAllowlistText] = useState('');
  const [clearingCache, setClearingCache] = useState(false);
  const [clearingUsage, setClearingUsage] = useState(false);
  const [migrationDialect, setMigrationDialect] = useState<DbDialect>('postgres');
  const [migrationConnectionString, setMigrationConnectionString] = useState('');
  const [connectionMode, setConnectionMode] = useState<'shorthand' | 'advanced'>('shorthand');
  const [showShorthandOptional, setShowShorthandOptional] = useState(false);
  const [shorthandConnection, setShorthandConnection] = useState<ShorthandConnection>({
    host: '',
    user: '',
    password: '',
    port: '5432',
    database: 'postgres',
  });
  const [migrationOverwrite, setMigrationOverwrite] = useState(true);
  const [migrationSsl, setMigrationSsl] = useState(false);
  const [testingMigrationConnection, setTestingMigrationConnection] = useState(false);
  const [migratingDatabase, setMigratingDatabase] = useState(false);
  const [savingRuntimeDatabase, setSavingRuntimeDatabase] = useState(false);
  const [migrationSummary, setMigrationSummary] = useState<DatabaseMigrationSummary | null>(null);
  const [runtimeDatabaseState, setRuntimeDatabaseState] = useState<RuntimeDatabaseState | null>(null);
  const [showChangeKey, setShowChangeKey] = useState(false);
  const [factoryResetOpen, setFactoryResetOpen] = useState(false);
  const factoryResetPresence = useAnimatedVisibility(factoryResetOpen, 220);
  const [factoryResetting, setFactoryResetting] = useState(false);
  const [factoryResetSecondsLeft, setFactoryResetSecondsLeft] = useState(FACTORY_RESET_CONFIRM_SECONDS);
  const toast = useToast();

  const activeRoutingProfile = useMemo(
    () => resolveRoutingProfilePreset(runtime.routingWeights),
    [runtime.routingWeights],
  );

  const configuredPayloadRuleCount = useMemo(
    () => payloadVisualRules.filter((rule) => !isVisualPayloadRuleBlank(rule)).length,
    [payloadVisualRules],
  );

  const generatedConnectionString = useMemo(() => (
    buildShorthandConnectionString(migrationDialect, shorthandConnection)
  ), [migrationDialect, shorthandConnection]);

  const effectiveMigrationConnectionString = useMemo(() => {
    if (migrationDialect === 'sqlite') return migrationConnectionString.trim();
    if (connectionMode === 'advanced') return migrationConnectionString.trim();
    return generatedConnectionString.trim();
  }, [connectionMode, generatedConnectionString, migrationConnectionString, migrationDialect]);

  useEffect(() => {
    const defaults = getDialectDefaults(migrationDialect);
    if (migrationDialect === 'sqlite') {
      setConnectionMode('advanced');
      return;
    }
    setShorthandConnection((prev) => ({
      ...prev,
      port: defaults.port,
      database: defaults.database,
    }));
  }, [migrationDialect]);


  useEffect(() => {
    if (!factoryResetOpen) {
      setFactoryResetSecondsLeft(FACTORY_RESET_CONFIRM_SECONDS);
      return;
    }
    setFactoryResetSecondsLeft(FACTORY_RESET_CONFIRM_SECONDS);
    const timer = globalThis.setInterval(() => {
      setFactoryResetSecondsLeft((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => globalThis.clearInterval(timer);
  }, [factoryResetOpen]);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    minHeight: 40,
    padding: '10px 14px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    outline: 'none',
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
  };
  const settingsModernCardStyle: React.CSSProperties = {
    padding: isMobile ? 20 : 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  };
  const settingsModernHeaderStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    flexWrap: 'wrap',
  };
  const settingsModernTitleBlockStyle: React.CSSProperties = {
    display: 'grid',
    gap: 6,
    minWidth: 0,
  };
  const settingsModernTitleStyle: React.CSSProperties = {
    fontSize: 15,
    fontWeight: 600,
    lineHeight: 1.35,
    color: 'var(--color-text-primary)',
  };
  const settingsModernDescriptionStyle: React.CSSProperties = {
    fontSize: 12,
    lineHeight: 1.75,
    color: 'var(--color-text-muted)',
  };
  const settingsModernPillRowStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  };
  const settingsModernToggleStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: isMobile ? 12 : 16,
    padding: '14px 16px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border-light)',
    background: 'color-mix(in srgb, var(--color-bg) 78%, var(--color-bg-card))',
    cursor: 'pointer',
  };
  const settingsModernToggleCopyStyle: React.CSSProperties = {
    display: 'grid',
    gap: 6,
    minWidth: 0,
  };
  const settingsModernFieldCardStyle: React.CSSProperties = {
    display: 'grid',
    gap: 10,
    padding: '14px 16px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border-light)',
    background: 'color-mix(in srgb, var(--color-bg) 82%, var(--color-bg-card))',
  };
  const settingsModernFieldLabelStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
  };
  const settingsModernFieldHintStyle: React.CSSProperties = {
    fontSize: 12,
    lineHeight: 1.7,
    color: 'var(--color-text-muted)',
    marginTop: -2,
  };
  const settingsModernActionsStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
  };

  const getSettingsPillStyle = (tone: SettingsPillTone): React.CSSProperties => {
    const toneStyles: Record<SettingsPillTone, React.CSSProperties> = {
      neutral: {
        borderColor: 'color-mix(in srgb, var(--color-text-muted) 12%, var(--color-border-light))',
        background: 'color-mix(in srgb, var(--color-text-muted) 8%, var(--color-bg-card))',
        color: 'var(--color-text-secondary)',
      },
      primary: {
        borderColor: 'color-mix(in srgb, var(--color-primary) 20%, var(--color-border-light))',
        background: 'color-mix(in srgb, var(--color-primary-light) 64%, var(--color-bg-card))',
        color: 'var(--color-primary)',
      },
      warning: {
        borderColor: 'color-mix(in srgb, var(--color-warning) 20%, var(--color-border-light))',
        background: 'color-mix(in srgb, var(--color-warning-soft) 68%, var(--color-bg-card))',
        color: 'var(--color-warning)',
      },
      danger: {
        borderColor: 'color-mix(in srgb, var(--color-danger) 20%, var(--color-border-light))',
        background: 'color-mix(in srgb, var(--color-danger-soft) 66%, var(--color-bg-card))',
        color: 'var(--color-danger)',
      },
    };

    return {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '5px 10px',
      borderRadius: 999,
      border: '1px solid var(--color-border-light)',
      fontSize: 12,
      fontWeight: 600,
      lineHeight: 1.2,
      whiteSpace: 'nowrap',
      ...toneStyles[tone],
    };
  };

  const proxyTransportModeLabel = runtime.codexUpstreamWebsocketEnabled ? '上游 WebSocket 已启用' : 'HTTP 优先';
  const proxyTransportQueueLabel = `会话池 ${runtime.proxySessionChannelConcurrencyLimit} 并发 / ${runtime.proxySessionChannelQueueWaitMs}ms`;

  const syncPayloadRuleDraftsFromObject = (value: unknown) => {
    setPayloadRuleDrafts(normalizePayloadRulesForEditor(value));
    setPayloadAdvancedDirty(false);
  };

  const syncPayloadVisualRulesFromObject = (value: unknown) => {
    setPayloadVisualRules(payloadRulesToVisualRules(value));
  };

  const applyVisualPayloadRules = (
    nextRulesOrUpdater: VisualPayloadRule[] | ((current: VisualPayloadRule[]) => VisualPayloadRule[]),
  ) => {
    setPayloadVisualRules((currentRules) => {
      const nextRules = typeof nextRulesOrUpdater === 'function'
        ? nextRulesOrUpdater(currentRules)
        : nextRulesOrUpdater;
      const serialized = visualRulesToPayloadRules(nextRules);
      if (serialized.success) {
        syncPayloadRuleDraftsFromObject(serialized.value);
      }
      return nextRules;
    });
  };

  const loadSettings = async () => {
    setLoading(true);
    try {
      const [authInfo, runtimeInfo, runtimeDatabaseInfo] = await Promise.all([
        api.getAuthInfo(),
        api.getRuntimeSettings(),
        api.getRuntimeDatabaseConfig(),
      ]);
      setMaskedToken(authInfo.masked || '****');
      const routeCooldownInput = resolveRouteCooldownInput(runtimeInfo.tokenRouterFailureCooldownMaxSec);
      setRuntime({
        checkinCron: runtimeInfo.checkinCron || '0 8 * * *',
        checkinScheduleMode: runtimeInfo.checkinScheduleMode === 'interval' ? 'interval' : 'cron',
        checkinIntervalHours: Number(runtimeInfo.checkinIntervalHours) >= 1
          ? Math.min(24, Math.trunc(Number(runtimeInfo.checkinIntervalHours)))
          : 6,
        balanceRefreshCron: runtimeInfo.balanceRefreshCron || '0 * * * *',
        logCleanupCron: runtimeInfo.logCleanupCron || '0 6 * * *',
        logCleanupUsageLogsEnabled: !!runtimeInfo.logCleanupUsageLogsEnabled,
        logCleanupProgramLogsEnabled: !!runtimeInfo.logCleanupProgramLogsEnabled,
        logCleanupRetentionDays: Number(runtimeInfo.logCleanupRetentionDays) >= 1
          ? Math.trunc(Number(runtimeInfo.logCleanupRetentionDays))
          : 30,
        modelAvailabilityProbeEnabled: !!runtimeInfo.modelAvailabilityProbeEnabled,
        sensitiveWordDetectionEnabled: runtimeInfo.sensitiveWordDetectionEnabled !== false,
        antiProbeMinTextLength: Number(runtimeInfo.antiProbeMinTextLength) >= 1
          ? Math.trunc(Number(runtimeInfo.antiProbeMinTextLength))
          : 8,
        codexUpstreamWebsocketEnabled: !!runtimeInfo.codexUpstreamWebsocketEnabled,
        responsesCompactFallbackToResponsesEnabled: !!runtimeInfo.responsesCompactFallbackToResponsesEnabled,
        disableCrossProtocolFallback: !!runtimeInfo.disableCrossProtocolFallback,
        proxySessionChannelConcurrencyLimit: Number(runtimeInfo.proxySessionChannelConcurrencyLimit) >= 0
          ? Math.trunc(Number(runtimeInfo.proxySessionChannelConcurrencyLimit))
          : 2,
        proxySessionChannelQueueWaitMs: Number(runtimeInfo.proxySessionChannelQueueWaitMs) >= 0
          ? Math.trunc(Number(runtimeInfo.proxySessionChannelQueueWaitMs))
          : 1500,
        routingFallbackUnitCost: Number(runtimeInfo.routingFallbackUnitCost) > 0
          ? Number(runtimeInfo.routingFallbackUnitCost)
          : 1,
        proxyFirstByteTimeoutSec: Number(runtimeInfo.proxyFirstByteTimeoutSec) >= 0
          ? Math.trunc(Number(runtimeInfo.proxyFirstByteTimeoutSec))
          : 15,
        proxyRouteProbeRate: Number(runtimeInfo.proxyRouteProbeRate) >= 0 && Number(runtimeInfo.proxyRouteProbeRate) <= 1
          ? Number(runtimeInfo.proxyRouteProbeRate)
          : 0.15,
        routeFailureCooldownMaxValue: routeCooldownInput.value,
        routeFailureCooldownMaxUnit: routeCooldownInput.unit,
        routingWeights: {
          ...defaultWeights,
          ...(runtimeInfo.routingWeights || {}),
        },
        defaultRoutingStrategy: runtimeInfo.defaultRoutingStrategy || 'weighted',
        proxyErrorKeywords: Array.isArray(runtimeInfo.proxyErrorKeywords)
          ? runtimeInfo.proxyErrorKeywords.filter((item: unknown) => typeof item === 'string')
          : [],
        proxyEmptyContentFailEnabled: !!runtimeInfo.proxyEmptyContentFailEnabled,
        adminIpAllowlist: Array.isArray(runtimeInfo.adminIpAllowlist)
          ? runtimeInfo.adminIpAllowlist.filter((item: unknown) => typeof item === 'string')
          : [],
        tunnelDashboardAccess: !!runtimeInfo.tunnelDashboardAccess,
        tunnelEnabled: !!runtimeInfo.tunnelEnabled,
        currentAdminIp: typeof runtimeInfo.currentAdminIp === 'string' ? runtimeInfo.currentAdminIp : '',
      });
      setProxyErrorKeywordsText(
        Array.isArray(runtimeInfo.proxyErrorKeywords)
          ? runtimeInfo.proxyErrorKeywords.filter((item: unknown) => typeof item === 'string').join('\n')
          : '',
      );
      syncPayloadRuleDraftsFromObject(runtimeInfo.payloadRules);
      syncPayloadVisualRulesFromObject(runtimeInfo.payloadRules);
      setAdminIpAllowlistText(
        Array.isArray(runtimeInfo.adminIpAllowlist)
          ? runtimeInfo.adminIpAllowlist.join('\n')
          : '',
      );
      if (runtimeDatabaseInfo?.active?.dialect) {
        const preferredDialect = (runtimeDatabaseInfo?.saved?.dialect || runtimeDatabaseInfo.active.dialect) as DbDialect;
        setMigrationDialect(preferredDialect);
      }
      setRuntimeDatabaseState({
        active: {
          dialect: (runtimeDatabaseInfo?.active?.dialect || 'sqlite') as DbDialect,
          connection: String(runtimeDatabaseInfo?.active?.connection || ''),
          ssl: !!runtimeDatabaseInfo?.active?.ssl,
        },
        saved: runtimeDatabaseInfo?.saved
          ? {
            dialect: runtimeDatabaseInfo.saved.dialect as DbDialect,
            connection: String(runtimeDatabaseInfo.saved.connection || ''),
            ssl: !!runtimeDatabaseInfo.saved.ssl,
          }
          : null,
        restartRequired: !!runtimeDatabaseInfo?.restartRequired,
      });
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '加载设置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

    const parseProxyErrorKeywords = (raw: string) => raw
    .split(/\r?\n|,/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const saveSchedule = async () => {
    setSavingSchedule(true);
    try {
      await api.updateRuntimeSettings({
        checkinCron: runtime.checkinCron,
        checkinScheduleMode: runtime.checkinScheduleMode,
        checkinIntervalHours: runtime.checkinIntervalHours,
        balanceRefreshCron: runtime.balanceRefreshCron,
        logCleanupCron: runtime.logCleanupCron,
        logCleanupUsageLogsEnabled: runtime.logCleanupUsageLogsEnabled,
        logCleanupProgramLogsEnabled: runtime.logCleanupProgramLogsEnabled,
        logCleanupRetentionDays: runtime.logCleanupRetentionDays,
      });
      toast.success('定时任务设置已保存');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '保存失败');
    } finally {
      setSavingSchedule(false);
    }
  };

  const triggerScheduleCheckin = async () => {
    setTestingCheckin(true);
    try {
      await api.triggerCheckinAll();
      toast.success('已开始全部签到，请稍后查看签到日志');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '触发签到失败');
    } finally {
      setTestingCheckin(false);
    }
  };



  const saveProxyTransportSettings = async () => {
    setSavingProxyTransport(true);
    try {
      const res = await api.updateRuntimeSettings({
        codexUpstreamWebsocketEnabled: runtime.codexUpstreamWebsocketEnabled,
        responsesCompactFallbackToResponsesEnabled: runtime.responsesCompactFallbackToResponsesEnabled,
        proxySessionChannelConcurrencyLimit: runtime.proxySessionChannelConcurrencyLimit,
        proxySessionChannelQueueWaitMs: runtime.proxySessionChannelQueueWaitMs,
      });
      setRuntime((prev) => ({
        ...prev,
        codexUpstreamWebsocketEnabled: typeof res?.codexUpstreamWebsocketEnabled === 'boolean'
          ? res.codexUpstreamWebsocketEnabled
          : prev.codexUpstreamWebsocketEnabled,
        responsesCompactFallbackToResponsesEnabled: typeof res?.responsesCompactFallbackToResponsesEnabled === 'boolean'
          ? res.responsesCompactFallbackToResponsesEnabled
          : prev.responsesCompactFallbackToResponsesEnabled,
        proxySessionChannelConcurrencyLimit: Number(res?.proxySessionChannelConcurrencyLimit) >= 0
          ? Math.trunc(Number(res.proxySessionChannelConcurrencyLimit))
          : prev.proxySessionChannelConcurrencyLimit,
        proxySessionChannelQueueWaitMs: Number(res?.proxySessionChannelQueueWaitMs) >= 0
          ? Math.trunc(Number(res.proxySessionChannelQueueWaitMs))
          : prev.proxySessionChannelQueueWaitMs,
      }));
      toast.success('传输与会话并发设置已保存');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '保存失败');
    } finally {
      setSavingProxyTransport(false);
    }
  };


  const saveProxyFailureRules = async () => {
    setSavingProxyFailureRules(true);
    try {
      const keywords = parseProxyErrorKeywords(proxyErrorKeywordsText);
      const res = await api.updateRuntimeSettings({
        proxyErrorKeywords: keywords,
        proxyEmptyContentFailEnabled: runtime.proxyEmptyContentFailEnabled,
      });
      const nextKeywords = Array.isArray(res?.proxyErrorKeywords)
        ? res.proxyErrorKeywords
        : keywords;
      setRuntime((prev) => ({
        ...prev,
        proxyErrorKeywords: nextKeywords,
        proxyEmptyContentFailEnabled: typeof res?.proxyEmptyContentFailEnabled === 'boolean'
          ? res.proxyEmptyContentFailEnabled
          : prev.proxyEmptyContentFailEnabled,
      }));
      setProxyErrorKeywordsText(nextKeywords.join('\n'));
      toast.success('代理失败规则已保存');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '保存失败');
    } finally {
      setSavingProxyFailureRules(false);
    }
  };

  const savePayloadRules = async () => {
    const nextPayloadRules = payloadAdvancedDirty
      ? parsePayloadRulesFromDrafts(payloadRuleDrafts)
      : visualRulesToPayloadRules(payloadVisualRules);
    if (!nextPayloadRules.success) {
      toast.error(nextPayloadRules.message);
      return;
    }

    setSavingPayloadRules(true);
    try {
      const res = await api.updateRuntimeSettings({
        payloadRules: nextPayloadRules.value,
      });
      syncPayloadRuleDraftsFromObject(res?.payloadRules);
      syncPayloadVisualRulesFromObject(res?.payloadRules);
      toast.success('Payload 规则已保存');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '保存 Payload 规则失败');
    } finally {
      setSavingPayloadRules(false);
    }
  };

  const applyCodexDefaultHighReasoningPreset = () => {
    applyVisualPayloadRules((currentRules) => [
      ...currentRules.filter((rule) => !isVisualPayloadRuleBlank(rule)),
      ...createCodexDefaultHighReasoningVisualPreset(),
    ]);
    setShowPayloadRulesEditor(true);
    toast.success('已填入 Codex 默认高推理预设');
  };

  const addPayloadVisualRule = () => {
    applyVisualPayloadRules((currentRules) => [
      ...currentRules,
      createVisualPayloadRule(),
    ]);
  };

  const updatePayloadVisualRule = (ruleId: string, patch: Partial<VisualPayloadRule>) => {
    applyVisualPayloadRules((currentRules) => currentRules.map((rule) => {
      if (rule.id !== ruleId) return rule;
      const nextAction = (patch.action ?? rule.action) as PayloadRuleAction;
      const nextValueMode = patch.valueMode ?? (
        nextAction === 'default-raw' || nextAction === 'override-raw'
          ? 'json'
          : rule.valueMode
      );
      return {
        ...rule,
        ...patch,
        action: nextAction,
        valueMode: nextAction === 'filter' ? 'text' : nextValueMode,
        value: nextAction === 'filter' ? '' : (patch.value ?? rule.value),
      };
    }));
  };

  const removePayloadVisualRule = (ruleId: string) => {
    applyVisualPayloadRules((currentRules) => currentRules.filter((rule) => rule.id !== ruleId));
  };

  const syncVisualRulesFromAdvancedJson = () => {
    const parsedPayloadRules = parsePayloadRulesFromDrafts(payloadRuleDrafts);
    if (!parsedPayloadRules.success) {
      toast.error(parsedPayloadRules.message);
      return;
    }
    syncPayloadVisualRulesFromObject(parsedPayloadRules.value);
    setPayloadAdvancedDirty(false);
    toast.success('已将高级 JSON 同步到可视化规则');
  };

  const saveRouting = async () => {
    setSavingRouting(true);
    try {
      await api.updateRuntimeSettings({
        routingWeights: runtime.routingWeights,
        defaultRoutingStrategy: runtime.defaultRoutingStrategy || 'weighted',
        routingFallbackUnitCost: runtime.routingFallbackUnitCost,
        proxyFirstByteTimeoutSec: Number.isFinite(runtime.proxyFirstByteTimeoutSec)
          ? Math.max(0, Math.trunc(runtime.proxyFirstByteTimeoutSec))
          : 0,
        proxyRouteProbeRate: Number.isFinite(runtime.proxyRouteProbeRate)
          ? Math.min(1, Math.max(0, runtime.proxyRouteProbeRate))
          : 0.15,
        tokenRouterFailureCooldownMaxSec: toRouteCooldownSeconds(
          runtime.routeFailureCooldownMaxValue,
          runtime.routeFailureCooldownMaxUnit,
        ),
        disableCrossProtocolFallback: runtime.disableCrossProtocolFallback,
      });
      toast.success('路由策略已保存');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '保存失败');
    } finally {
      setSavingRouting(false);
    }
  };

  const applyRoutingPreset = (preset: 'balanced' | 'stable' | 'cost') => {
    setRuntime((prev) => ({
      ...prev,
      routingWeights: applyRoutingProfilePreset(preset),
    }));
  };

  const saveSecuritySettings = async () => {
    if (isTunnelClientView) {
      toast.error('通过公网隧道时不允许修改会话与安全设置');
      return;
    }
    setSavingSecurity(true);
    try {
      const allowlist = adminIpAllowlistText
        .split(/\r?\n|,/g)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const res = await api.updateRuntimeSettings({
        adminIpAllowlist: allowlist,
      });
      setRuntime((prev) => ({
        ...prev,
        adminIpAllowlist: allowlist,
        currentAdminIp: typeof res?.currentAdminIp === 'string'
          ? res.currentAdminIp
          : prev.currentAdminIp,
      }));
      toast.success('安全设置已保存');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '保存失败');
    } finally {
      setSavingSecurity(false);
    }
  };


  const handleClearCache = async () => {
    if (!window.confirm('确认清理模型缓存并重建路由？')) return;
    setClearingCache(true);
    try {
      const res = await api.clearRuntimeCache();
      toast.success(`缓存已清理（模型缓存 ${res.deletedModelAvailability || 0} 条）`);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '清理缓存失败');
    } finally {
      setClearingCache(false);
    }
  };

  const saveAntiProbeSettings = async () => {
    setSavingSecurity(true);
    try {
      const res = await api.updateRuntimeSettings({
        sensitiveWordDetectionEnabled: runtime.sensitiveWordDetectionEnabled,
        antiProbeMinTextLength: runtime.antiProbeMinTextLength,
      });
      setRuntime((prev) => ({
        ...prev,
        sensitiveWordDetectionEnabled: typeof res?.sensitiveWordDetectionEnabled === 'boolean'
          ? res.sensitiveWordDetectionEnabled
          : prev.sensitiveWordDetectionEnabled,
        antiProbeMinTextLength: Number(res?.antiProbeMinTextLength) >= 1
          ? Math.trunc(Number(res.antiProbeMinTextLength))
          : prev.antiProbeMinTextLength,
      }));
      toast.success('反探测设置已保存');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '保存失败');
    } finally {
      setSavingSecurity(false);
    }
  };

  const handleClearUsage = async () => {
    if (!window.confirm('确认清理占用统计与使用日志？')) return;
    setClearingUsage(true);
    try {
      const res = await api.clearUsageData();
      toast.success(`占用统计已清理（日志 ${res.deletedProxyLogs || 0} 条）`);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '清理占用失败');
    } finally {
      setClearingUsage(false);
    }
  };

  const closeFactoryResetModal = () => {
    if (factoryResetting) return;
    setFactoryResetOpen(false);
  };


  const handleFactoryReset = async () => {
    if (factoryResetSecondsLeft > 0 || factoryResetting) return;
    setFactoryResetting(true);
    try {
      await api.factoryReset();
      clearAppInstallationState(localStorage);
      window.location.reload();
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || '重新初始化系统失败');
      setFactoryResetting(false);
    }
  };

  const handleTestExternalDatabaseConnection = async () => {
    if (!effectiveMigrationConnectionString) {
      toast.info('Please fill target database connection first');
      return;
    }

    const inferredDialect = inferUrlDialect(effectiveMigrationConnectionString);
    if (migrationDialect === 'sqlite' && inferredDialect) {
      toast.error(`当前选择 SQLite，但连接串是 ${inferredDialect.toUpperCase()} URL，请先切换方言`);
      return;
    }

    setTestingMigrationConnection(true);
    try {
      const res = await api.testExternalDatabaseConnection({
        dialect: migrationDialect,
        connectionString: effectiveMigrationConnectionString,
        ssl: migrationSsl,
      });
      toast.success(`Connection success: ${res.connection || migrationDialect}`);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || 'Target database connection failed');
    } finally {
      setTestingMigrationConnection(false);
    }
  };

  const handleMigrateToExternalDatabase = async () => {
    if (!effectiveMigrationConnectionString) {
      toast.info('Please fill target database connection first');
      return;
    }

    const inferredDialect = inferUrlDialect(effectiveMigrationConnectionString);
    if (migrationDialect === 'sqlite' && inferredDialect) {
      toast.error(`当前选择 SQLite，但连接串是 ${inferredDialect.toUpperCase()} URL，请先切换方言`);
      return;
    }

    const warning = migrationOverwrite
      ? 'Confirm migration and overwrite existing data in target database?'
      : 'Confirm migration to target database? If target has data, migration may fail.';
    if (!window.confirm(warning)) return;

    setMigratingDatabase(true);
    try {
      const res = await api.migrateExternalDatabase({
        dialect: migrationDialect,
        connectionString: effectiveMigrationConnectionString,
        overwrite: migrationOverwrite,
        ssl: migrationSsl,
      });
      setMigrationSummary(res);
      toast.success(res?.message || 'Database migration completed');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || 'Database migration failed');
    } finally {
      setMigratingDatabase(false);
    }
  };

  const handleSaveRuntimeDatabaseConfig = async () => {
    if (!effectiveMigrationConnectionString) {
      toast.info('Please fill target database connection first');
      return;
    }

    const inferredDialect = inferUrlDialect(effectiveMigrationConnectionString);
    if (migrationDialect === 'sqlite' && inferredDialect) {
      toast.error(`当前选择 SQLite，但连接串是 ${inferredDialect.toUpperCase()} URL，请先切换方言`);
      return;
    }

    setSavingRuntimeDatabase(true);
    try {
      const res = await api.updateRuntimeDatabaseConfig({
        dialect: migrationDialect,
        connectionString: effectiveMigrationConnectionString,
        ssl: migrationSsl,
      });
      setRuntimeDatabaseState({
        active: {
          dialect: (res?.active?.dialect || 'sqlite') as DbDialect,
          connection: String(res?.active?.connection || ''),
          ssl: !!res?.active?.ssl,
        },
        saved: res?.saved
          ? {
            dialect: res.saved.dialect as DbDialect,
            connection: String(res.saved.connection || ''),
            ssl: !!res.saved.ssl,
          }
          : null,
        restartRequired: !!res?.restartRequired,
      });
      toast.success(res?.message || 'Runtime database config saved');
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      toast.error(errMessage || 'Runtime database config save failed');
    } finally {
      setSavingRuntimeDatabase(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-fade-in">
        <div className="skeleton" style={{ width: 220, height: 28, marginBottom: 20 }} />
        <div className="skeleton" style={{ width: '100%', height: 320, borderRadius: 'var(--radius-sm)' }} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h2 className="page-title">系统设置</h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 480px), 1fr))', gap: 16 }}>
        <div className="card animate-slide-up stagger-2" style={{ padding: 20, order: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>管理员登录令牌</div>
          <code style={{ display: 'block', padding: '10px 14px', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-light)', marginBottom: 12 }}>
            {maskedToken || '****'}
          </code>
          <button onClick={() => setShowChangeKey(true)} className="btn btn-primary" disabled={isTunnelClientView} title={isTunnelClientView ? '公网隧道访问时不可修改' : undefined}>修改登录令牌</button>
          <ChangeKeyModal
            open={showChangeKey}
            onClose={() => {
              setShowChangeKey(false);
              api.getAuthInfo().then((r: any) => setMaskedToken(r.masked || '****')).catch(() => { });
            }}
          />
        </div>

        <div className="card animate-slide-up stagger-2" style={{ padding: 20, order: 2 }} data-settings-card="public-tunnel">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>公网隧道访问</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
            对应仪表盘「创建隧道」。默认公网只允许 API；开启后才可通过隧道 URL 打开控制台（仍需管理员登录令牌）。
            {isTunnelClientView ? ' 当前为公网隧道访问，此开关已锁定。' : ''}
          </div>
          <label style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 14px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--color-border-light)',
            background: 'var(--color-bg)',
            cursor: 'pointer',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                允许通过隧道访问控制台
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, lineHeight: 1.45 }}>
                关闭：仅 /v1/* API　｜　开启：控制台 + 管理 API
              </div>
            </div>
            <input
              type="checkbox"
              checked={!!runtime.tunnelDashboardAccess}
              disabled={isTunnelClientView}
              onChange={async (e) => {
                if (isTunnelClientView) {
                  toast.error('通过公网隧道时不允许修改该选项');
                  return;
                }
                const next = e.target.checked;
                setRuntime((prev) => ({ ...prev, tunnelDashboardAccess: next }));
                try {
                  await api.setTunnelDashboardAccess(next);
                  toast.success(next ? '已允许隧道访问控制台' : '已限制隧道仅 API 访问');
                } catch (err) {
                  const errMessage = err instanceof Error ? err.message : String(err);
                  setRuntime((prev) => ({ ...prev, tunnelDashboardAccess: !next }));
                  toast.error(errMessage || '更新失败');
                }
              }}
              style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
            />
          </label>
        </div>

        <div className="card animate-slide-up stagger-2" style={{ padding: 20, order: 3 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>定时任务</div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '180px 180px auto', gap: 12, alignItems: 'end', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>签到方式</div>
              <ModernSelect
                value={runtime.checkinScheduleMode}
                onChange={(value) => setRuntime((prev) => ({
                  ...prev,
                  checkinScheduleMode: value === 'interval' ? 'interval' : 'cron',
                }))}
                options={CHECKIN_SCHEDULE_MODE_OPTIONS.map((item) => ({ ...item }))}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>签到间隔</div>
              <ModernSelect
                value={String(runtime.checkinIntervalHours)}
                onChange={(value) => setRuntime((prev) => ({
                  ...prev,
                  checkinIntervalHours: Math.min(24, Math.max(1, Math.trunc(Number(value) || 1))),
                }))}
                disabled={runtime.checkinScheduleMode !== 'interval'}
                options={CHECKIN_INTERVAL_OPTIONS}
              />
            </div>
            <button
              onClick={triggerScheduleCheckin}
              disabled={testingCheckin}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}
            >
              {testingCheckin ? '触发中...' : '测试一次签到'}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>签到 Cron</div>
              <input
                value={runtime.checkinCron}
                onChange={(e) => setRuntime((prev) => ({ ...prev, checkinCron: e.target.value }))}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                disabled={runtime.checkinScheduleMode !== 'cron'}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>余额刷新 Cron</div>
              <input
                value={runtime.balanceRefreshCron}
                onChange={(e) => setRuntime((prev) => ({ ...prev, balanceRefreshCron: e.target.value }))}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
              />
            </div>
          </div>
          <div
            style={{
              marginTop: 16,
              paddingTop: 16,
              borderTop: '1px solid var(--color-border-light)',
              display: 'grid',
              gap: 12,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>自动清理日志</div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 160px', gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>清理 Cron</div>
                <input
                  value={runtime.logCleanupCron}
                  onChange={(e) => setRuntime((prev) => ({ ...prev, logCleanupCron: e.target.value }))}
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>保留天数</div>
                <input
                  type="number"
                  min={1}
                  value={runtime.logCleanupRetentionDays}
                  onChange={(e) => setRuntime((prev) => {
                    const nextValue = Number(e.target.value);
                    return {
                      ...prev,
                      logCleanupRetentionDays: Number.isFinite(nextValue) && nextValue >= 1
                        ? Math.trunc(nextValue)
                        : prev.logCleanupRetentionDays,
                    };
                  })}
                  style={inputStyle}
                />
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={runtime.logCleanupUsageLogsEnabled}
                  onChange={(e) => setRuntime((prev) => ({ ...prev, logCleanupUsageLogsEnabled: e.target.checked }))}
                />
                清理使用日志
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={runtime.logCleanupProgramLogsEnabled}
                  onChange={(e) => setRuntime((prev) => ({ ...prev, logCleanupProgramLogsEnabled: e.target.checked }))}
                />
                清理程序日志
              </label>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
              默认每天早上 6 点执行。按每次定时任务执行时间，清理早于“保留天数”的日志；两个选项都不勾选时不会实际删除日志。
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button onClick={saveSchedule} disabled={savingSchedule} className="btn btn-primary">
              {savingSchedule ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存定时任务'}
            </button>
          </div>
        </div>


        <div className="card animate-slide-up stagger-4" style={{ padding: 20, order: 5 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>代理失败判定</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            命中任一关键词或空内容时判定失败，可触发重试。
          </div>
          <textarea
            value={proxyErrorKeywordsText}
            onChange={(e) => setProxyErrorKeywordsText(e.target.value)}
            placeholder="一行一个关键词，或逗号分隔"
            style={{
              ...inputStyle,
              fontFamily: 'var(--font-mono)',
              minHeight: 96,
              resize: 'vertical',
              marginBottom: 12,
            }}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={runtime.proxyEmptyContentFailEnabled}
              onChange={(e) => setRuntime((prev) => ({ ...prev, proxyEmptyContentFailEnabled: e.target.checked }))}
            />
            空内容（completion=0，即使 prompt 有 token 也算）判定失败
          </label>
          <div>
            <button onClick={saveProxyFailureRules} disabled={savingProxyFailureRules} className="btn btn-primary">
              {savingProxyFailureRules ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存失败规则'}
            </button>
          </div>
        </div>

        <div className="card animate-slide-up stagger-4" style={{ ...settingsModernCardStyle, order: 6 }} data-settings-card="payload-rules">
          <div style={settingsModernHeaderStyle}>
            <div style={settingsModernTitleBlockStyle}>
              <div style={settingsModernTitleStyle}>Payload 规则</div>
              <div style={settingsModernDescriptionStyle}>
                对匹配模型的上游请求做默认注入、强制覆盖或字段过滤。规则结构参考 CPA 的 payload 配置，常见场景可直接注入
                {' '}
                <code style={{ fontFamily: 'var(--font-mono)' }}>reasoning.effort</code>
                {' '}
                之类的参数。
              </div>
            </div>
            <div style={settingsModernPillRowStyle}>
              <span style={getSettingsPillStyle(configuredPayloadRuleCount > 0 ? 'primary' : 'neutral')}>
                {configuredPayloadRuleCount > 0 ? `已配置 ${configuredPayloadRuleCount} 条` : '未配置'}
              </span>
              <span style={getSettingsPillStyle(payloadAdvancedDirty ? 'warning' : 'neutral')}>
                {payloadAdvancedDirty ? '高级 JSON 待同步/保存' : '保存后立即生效'}
              </span>
            </div>
          </div>
          <div style={settingsModernFieldCardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                <div style={settingsModernFieldLabelStyle}>常用预设</div>
                <div style={settingsModernFieldHintStyle}>
                  先用预设快速填充，再通过下面的可视化规则编辑器细调。复杂场景仍可回退到高级 JSON。
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)' }}
                  onClick={applyCodexDefaultHighReasoningPreset}
                >
                  Codex 默认高推理
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)' }}
                  onClick={addPayloadVisualRule}
                >
                  新增规则
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)' }}
                  onClick={() => setShowPayloadRulesEditor((prev) => !prev)}
                >
                  {showPayloadRulesEditor ? '收起高级 JSON 编辑' : '展开高级 JSON 编辑'}
                </button>
              </div>
            </div>
          </div>
          {payloadVisualRules.length <= 0 ? (
            <div style={settingsModernFieldCardStyle}>
              <div style={settingsModernFieldLabelStyle}>还没有可视化规则</div>
              <div style={settingsModernFieldHintStyle}>
                可以先点上面的预设，也可以直接新增一条规则：选择动作、协议、模型匹配、字段路径和值即可。
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {payloadVisualRules.map((rule, index) => (
                <div
                  key={rule.id}
                  style={settingsModernFieldCardStyle}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <div style={settingsModernFieldLabelStyle}>规则 {index + 1}</div>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ border: '1px solid var(--color-border)', color: 'var(--color-danger)' }}
                      onClick={() => removePayloadVisualRule(rule.id)}
                    >
                      删除
                    </button>
                  </div>
                  <ResponsiveFormGrid columns={2}>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>动作</div>
                      <ModernSelect
                        size="sm"
                        data-testid={`payload-rule-action-${index + 1}`}
                        value={rule.action}
                        onChange={(value) => updatePayloadVisualRule(rule.id, { action: value as PayloadRuleAction })}
                        options={PAYLOAD_RULE_ACTION_OPTIONS}
                        placeholder="选择动作"
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>协议</div>
                      <ModernSelect
                        size="sm"
                        data-testid={`payload-rule-protocol-${index + 1}`}
                        value={rule.protocol}
                        onChange={(value) => updatePayloadVisualRule(rule.id, { protocol: String(value || '') })}
                        options={PAYLOAD_RULE_PROTOCOL_OPTIONS}
                        placeholder="全部协议"
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>模型匹配</div>
                      <input
                        type="text"
                        aria-label={`Payload 规则可视化模型 ${index + 1}`}
                        value={rule.modelPattern}
                        onChange={(e) => updatePayloadVisualRule(rule.id, { modelPattern: e.target.value })}
                        placeholder="例如 gpt-*"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>字段路径</div>
                      <input
                        type="text"
                        aria-label={`Payload 规则可视化路径 ${index + 1}`}
                        value={rule.path}
                        onChange={(e) => updatePayloadVisualRule(rule.id, { path: e.target.value })}
                        placeholder="例如 reasoning.effort"
                        style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                      />
                    </div>
                  </ResponsiveFormGrid>
                  {rule.action === 'filter' ? (
                    <div style={settingsModernFieldHintStyle}>
                      删除字段规则不需要填写值，命中后会从请求中移除这条路径。
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {(rule.action === 'default' || rule.action === 'override') && (
                        <div style={{ width: isMobile ? '100%' : 180 }}>
                          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>值类型</div>
                          <ModernSelect
                            size="sm"
                            data-testid={`payload-rule-value-mode-${index + 1}`}
                            value={rule.valueMode}
                            onChange={(value) => updatePayloadVisualRule(rule.id, {
                              valueMode: value as VisualPayloadRuleValueMode,
                              value: value === 'json' && rule.valueMode !== 'json'
                                ? (rule.value ? JSON.stringify(rule.value) : '')
                                : rule.value,
                            })}
                            options={PAYLOAD_RULE_VALUE_MODE_OPTIONS}
                            placeholder="值类型"
                          />
                        </div>
                      )}
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
                          {rule.action === 'default-raw' || rule.action === 'override-raw'
                            ? '原始 JSON 值'
                            : (rule.valueMode === 'json' ? 'JSON 值' : '文本值')}
                        </div>
                        {(rule.action === 'default-raw' || rule.action === 'override-raw' || rule.valueMode === 'json') ? (
                          <textarea
                            aria-label={`Payload 规则可视化值 ${index + 1}`}
                            value={rule.value}
                            onChange={(e) => updatePayloadVisualRule(rule.id, { value: e.target.value })}
                            placeholder={rule.action === 'default-raw' || rule.action === 'override-raw'
                              ? '{"type":"json_schema"}'
                              : '{"effort":"high"}'}
                            rows={3}
                            style={{
                              ...inputStyle,
                              minHeight: 88,
                              fontFamily: 'var(--font-mono)',
                              lineHeight: 1.6,
                              resize: 'vertical',
                            }}
                          />
                        ) : (
                          <input
                            type="text"
                            aria-label={`Payload 规则可视化值 ${index + 1}`}
                            value={rule.value}
                            onChange={(e) => updatePayloadVisualRule(rule.id, { value: e.target.value })}
                            placeholder="例如 high"
                            style={inputStyle}
                          />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className={`anim-collapse ${showPayloadRulesEditor ? 'is-open' : ''}`.trim()}>
            <div className="anim-collapse-inner" style={{ paddingTop: 2 }}>
              <div style={settingsModernFieldCardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    <div style={settingsModernFieldLabelStyle}>高级 JSON 编辑</div>
                    <div style={settingsModernFieldHintStyle}>
                      适合直接粘贴 CPA 风格规则。手动改完后，可点击“同步到可视化规则”回到上面的低门槛编辑器。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ border: '1px solid var(--color-border)' }}
                    onClick={syncVisualRulesFromAdvancedJson}
                  >
                    同步到可视化规则
                  </button>
                </div>
              </div>
              <ResponsiveFormGrid columns={2}>
                {PAYLOAD_RULES_EDITOR_SECTIONS.map((section) => (
                  <div key={section.key} style={settingsModernFieldCardStyle}>
                    <div style={settingsModernFieldLabelStyle}>{section.title}</div>
                    <div style={settingsModernFieldHintStyle}>{section.description}</div>
                    <textarea
                      aria-label={`Payload 规则 ${section.key}`}
                      value={payloadRuleDrafts[section.key]}
                      onChange={(e) => {
                        const nextValue = e.target.value;
                        setPayloadRuleDrafts((prev) => ({
                          ...prev,
                          [section.key]: nextValue,
                        }));
                        setPayloadAdvancedDirty(true);
                      }}
                      placeholder={section.placeholder}
                      rows={6}
                      style={{
                        ...inputStyle,
                        minHeight: 144,
                        fontFamily: 'var(--font-mono)',
                        lineHeight: 1.6,
                        resize: 'vertical',
                      }}
                    />
                  </div>
                ))}
              </ResponsiveFormGrid>
            </div>
          </div>
          <div style={settingsModernActionsStyle}>
            <button onClick={savePayloadRules} disabled={savingPayloadRules} className="btn btn-primary">
              {savingPayloadRules ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存 Payload 规则'}
            </button>
          </div>
        </div>

        <div className="card animate-slide-up stagger-4" style={{ ...settingsModernCardStyle, order: 4 }} data-settings-card="proxy-transport">
          <div style={settingsModernHeaderStyle}>
            <div style={settingsModernTitleBlockStyle}>
              <div style={settingsModernTitleStyle}>Codex 上游传输与会话并发</div>
              <div style={settingsModernDescriptionStyle}>
                默认采用 HTTP 优先。只有这里开启后，metapi 才会在 Codex 请求上尝试把上游升级为 WebSocket。下游 Codex 客户端也必须同时启用 `/v1/responses` websocket，单开这里不会生效。
              </div>
            </div>
            <div style={settingsModernPillRowStyle}>
              <span style={getSettingsPillStyle(runtime.codexUpstreamWebsocketEnabled ? 'primary' : 'neutral')}>
                {proxyTransportModeLabel}
              </span>
              <span style={getSettingsPillStyle('neutral')}>
                {proxyTransportQueueLabel}
              </span>
            </div>
          </div>
          <label style={settingsModernToggleStyle}>
            <div style={settingsModernToggleCopyStyle}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>允许 metapi 到 Codex 上游使用 WebSocket</span>
              <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                仅在下游 Codex 客户端已同步开启 `/v1/responses` websocket 时启用；否则仍按 HTTP 优先执行。
              </span>
            </div>
            <input
              type="checkbox"
              checked={runtime.codexUpstreamWebsocketEnabled}
              onChange={(e) => setRuntime((prev) => ({ ...prev, codexUpstreamWebsocketEnabled: e.target.checked }))}
              style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
            />
          </label>
          <label style={settingsModernToggleStyle}>
            <div style={settingsModernToggleCopyStyle}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Compact 明确不支持时回退到普通 Responses</span>
              <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                仅对 `/v1/responses/compact` 生效。当上游明确返回 compact 不支持时，允许自动回退到普通 `/responses`。
              </span>
            </div>
            <input
              type="checkbox"
              checked={runtime.responsesCompactFallbackToResponsesEnabled}
              onChange={(e) => setRuntime((prev) => ({ ...prev, responsesCompactFallbackToResponsesEnabled: e.target.checked }))}
              style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
            />
          </label>
          <ResponsiveFormGrid columns={2}>
            <div style={settingsModernFieldCardStyle}>
              <div style={settingsModernFieldLabelStyle}>会话通道并发上限</div>
              <input
                type="number"
                min={0}
                value={runtime.proxySessionChannelConcurrencyLimit}
                onChange={(e) => {
                  const nextValue = Number(e.target.value);
                  setRuntime((prev) => ({
                    ...prev,
                    proxySessionChannelConcurrencyLimit: Number.isFinite(nextValue) && nextValue >= 0
                      ? Math.trunc(nextValue)
                      : prev.proxySessionChannelConcurrencyLimit,
                  }));
                }}
                style={inputStyle}
              />
              <div style={settingsModernFieldHintStyle}>
                只作用于能识别稳定 `session_id` 的会话型请求；普通请求不会进入这组 lease 池。
              </div>
            </div>
            <div style={settingsModernFieldCardStyle}>
              <div style={settingsModernFieldLabelStyle}>排队等待时间（毫秒）</div>
              <input
                type="number"
                min={0}
                step={100}
                value={runtime.proxySessionChannelQueueWaitMs}
                onChange={(e) => {
                  const nextValue = Number(e.target.value);
                  setRuntime((prev) => ({
                    ...prev,
                    proxySessionChannelQueueWaitMs: Number.isFinite(nextValue) && nextValue >= 0
                      ? Math.trunc(nextValue)
                      : prev.proxySessionChannelQueueWaitMs,
                  }));
                }}
                style={inputStyle}
              />
              <div style={settingsModernFieldHintStyle}>
                超过该时间仍拿不到会话通道时，本次请求会直接放弃排队，避免长期挂起。
              </div>
            </div>
          </ResponsiveFormGrid>
          <div style={settingsModernActionsStyle}>
            <button onClick={saveProxyTransportSettings} disabled={savingProxyTransport} className="btn btn-primary">
              {savingProxyTransport ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存传输与并发'}
            </button>
          </div>
        </div>
        <div className="card animate-slide-up stagger-5" style={{ padding: 20, gridColumn: '1 / -1', order: 7 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>路由策略</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            先选择预设策略，只有需要精调时再展开高级参数。
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: isMobile ? 12 : 28, alignItems: 'start' }}>
          <div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
              全局路由策略（所有路由统一生效）
            </div>
            <ModernSelect
              value={runtime.defaultRoutingStrategy || 'weighted'}
              onChange={(nextValue) => {
                setRuntime((prev) => ({
                  ...prev,
                  defaultRoutingStrategy: nextValue,
                }));
              }}
              options={[
                { value: 'weighted', label: '权重随机' },
                { value: 'round_robin', label: '轮询' },
                { value: 'stable_first', label: '稳定优先' },
              ]}
              placeholder="选择路由策略"
            />
            <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--color-text-muted)', marginTop: 6 }}>
              轮询：公平轮转，最久未选中的通道优先；稳定优先：按近期成功率加权，低成功率站点每 24 次请求灰度试探一次。
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
              路由探测率（跳过亲和性，直接走加权随机）
            </div>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              aria-label="路由探测率"
              value={runtime.proxyRouteProbeRate}
              onChange={(e) => {
                const nextValue = Number(e.target.value);
                setRuntime((prev) => ({
                  ...prev,
                  proxyRouteProbeRate: Number.isFinite(nextValue)
                    ? Math.min(1, Math.max(0, nextValue))
                    : prev.proxyRouteProbeRate,
                }));
              }}
              style={inputStyle}
            />
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.7, marginTop: 6 }}>
              默认 0.15（15%）。首次请求有一定概率跳过会话粘性和上次成功记录，直接进入加权均衡选路。设为 0 关闭探测、1 每次都探测。
            </div>
          </div>
          </div>
          <div>
          <div style={{ marginBottom: 12, maxWidth: 280 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
                无实测/配置/目录价时默认单价
            </div>
            <input
              type="number"
              min={0.000001}
              step={0.000001}
              value={runtime.routingFallbackUnitCost}
              onChange={(e) => {
                const nextValue = Number(e.target.value);
                setRuntime((prev) => ({
                  ...prev,
                  routingFallbackUnitCost: Number.isFinite(nextValue) && nextValue > 0 ? nextValue : prev.routingFallbackUnitCost,
                }));
              }}
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
              普通失败冷却上限
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
              <input
                type="number"
                aria-label="路由失败冷却上限数值"
                min={1}
                step={1}
                value={runtime.routeFailureCooldownMaxValue}
                onChange={(e) => {
                  const nextValue = Number(e.target.value);
                  setRuntime((prev) => ({
                    ...prev,
                    routeFailureCooldownMaxValue: Number.isFinite(nextValue) && nextValue > 0
                      ? Math.max(1, Math.trunc(nextValue))
                      : prev.routeFailureCooldownMaxValue,
                  }));
                }}
                style={{ ...inputStyle, flex: '1 1 180px', marginBottom: 0 }}
              />
              <div style={{ width: 132, minWidth: 132 }}>
                <ModernSelect
                  value={runtime.routeFailureCooldownMaxUnit}
                  onChange={(nextValue) => {
                    setRuntime((prev) => ({
                      ...prev,
                      routeFailureCooldownMaxUnit: nextValue as RouteCooldownUnit,
                    }));
                  }}
                  options={ROUTE_COOLDOWN_UNIT_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  placeholder="选择单位"
                />
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 6, lineHeight: 1.6 }}>
              支持秒、分钟、小时、天。只封顶普通失败与轮询分级冷却；429 限额类冷却仍优先遵循上游 reset 提示，避免过早重试。
            </div>
          </div>
          </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: isMobile ? 12 : 28, alignItems: 'start' }}>
          <div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
              首字超时（无首包 / 首 token）
            </div>
            <input
              type="number"
              min={0}
              step={1}
              aria-label="首字超时秒数"
              value={runtime.proxyFirstByteTimeoutSec}
              onChange={(e) => {
                const nextValue = Number(e.target.value);
                setRuntime((prev) => ({
                  ...prev,
                  proxyFirstByteTimeoutSec: Number.isFinite(nextValue) && nextValue >= 0
                    ? Math.trunc(nextValue)
                    : prev.proxyFirstByteTimeoutSec,
                }));
              }}
              style={inputStyle}
            />
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.7, marginTop: 6 }}>
              默认 15 秒；`0` 表示关闭。只有在指定时间内完全没有任何首包 / 首 token 返回时才切换渠道，已经开始输出的请求不会被这项超时打断。
            </div>
          </div>
          </div>
          <div style={{ paddingTop: 2 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={runtime.disableCrossProtocolFallback}
              onChange={(e) => setRuntime((prev) => ({
                ...prev,
                disableCrossProtocolFallback: e.target.checked,
              }))}
              style={{ marginTop: 2 }}
            />
            <span>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                失败时不尝试其他协议
              </span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
                仅影响 chat / messages / responses 之间的协议切换；不会关闭同协议兼容重试、OAuth 刷新或通道级重试。
              </span>
            </span>
          </label>
          </div>
          </div>


          <div className={`anim-collapse ${showAdvancedRouting ? 'is-open' : ''}`.trim()}>
            <div className="anim-collapse-inner" style={{ paddingTop: 2 }}>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
              {([
                ['baseWeightFactor', '基础权重因子'],
                ['valueScoreFactor', '价值分因子'],
                ['costWeight', '成本权重'],
                ['balanceWeight', '余额权重'],
                ['usageWeight', '使用频次权重'],
              ] as Array<[keyof RoutingWeights, string]>).map(([key, label]) => (
                <div key={key}>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{label}</div>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={runtime.routingWeights[key]}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setRuntime((prev) => ({
                        ...prev,
                        routingWeights: {
                          ...prev.routingWeights,
                          [key]: Number.isFinite(v) ? v : 0,
                        },
                      }));
                    }}
                    style={inputStyle}
                  />
                </div>
              ))}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0 12px' }}>
            <button
              onClick={() => applyRoutingPreset('balanced')}
              className="btn btn-ghost"
              style={{
                border: activeRoutingProfile === 'balanced' ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                color: activeRoutingProfile === 'balanced' ? 'var(--color-primary)' : undefined,
              }}
            >
              均衡
            </button>
            <button
              onClick={() => applyRoutingPreset('stable')}
              className="btn btn-ghost"
              style={{
                border: activeRoutingProfile === 'stable' ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                color: activeRoutingProfile === 'stable' ? 'var(--color-primary)' : undefined,
              }}
            >
              稳定优先
            </button>
            <button
              onClick={() => applyRoutingPreset('cost')}
              className="btn btn-ghost"
              style={{
                border: activeRoutingProfile === 'cost' ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                color: activeRoutingProfile === 'cost' ? 'var(--color-primary)' : undefined,
              }}
            >
              成本优先
            </button>
            <button
              onClick={() => setShowAdvancedRouting((prev) => !prev)}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              {showAdvancedRouting ? '收起高级参数' : '展开高级参数'}
            </button>
          </div>

          <div style={{ marginTop: 12 }}>
            <button onClick={saveRouting} disabled={savingRouting} className="btn btn-primary">
              {savingRouting ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存路由策略'}
            </button>
          </div>
        </div>

        <div className="card animate-slide-up stagger-8" style={{ padding: 20, order: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>数据库迁移（SQLite / MySQL / PostgreSQL）</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            可先测试连接，再迁移数据；迁移完成后可保存为运行数据库配置（重启容器后生效）。
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '180px 1fr', gap: 10, marginBottom: 10, alignItems: 'center' }}>
            <ModernSelect
              value={migrationDialect}
              onChange={(value) => setMigrationDialect(value as DbDialect)}
              options={[
                { value: 'postgres', label: 'PostgreSQL' },
                { value: 'mysql', label: 'MySQL' },
                { value: 'sqlite', label: 'SQLite' },
              ]}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
              {migrationDialect !== 'sqlite' && (
                <button
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)' }}
                  onClick={() => setConnectionMode((prev) => (prev === 'shorthand' ? 'advanced' : 'shorthand'))}
                >
                  {connectionMode === 'shorthand' ? '高级输入连接串' : '使用半自动简写'}
                </button>
              )}
            </div>
          </div>

          {migrationDialect === 'sqlite' ? (
            <input
              value={migrationConnectionString}
              onChange={(e) => setMigrationConnectionString(e.target.value)}
              placeholder="./data/target.db or file:///abs/path.db"
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)', marginBottom: 10 }}
            />
          ) : connectionMode === 'advanced' ? (
            <input
              value={migrationConnectionString}
              onChange={(e) => setMigrationConnectionString(e.target.value)}
              placeholder={migrationDialect === 'mysql'
                ? 'mysql://user:pass@host:3306/db'
                : 'postgres://user:pass@host:5432/db'}
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)', marginBottom: 10 }}
            />
          ) : (
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: 10, marginBottom: 8 }}>
                <input
                  value={shorthandConnection.host}
                  onChange={(e) => setShorthandConnection((prev) => ({ ...prev, host: e.target.value }))}
                  placeholder="Host (required)"
                  style={inputStyle}
                />
                <input
                  value={shorthandConnection.user}
                  onChange={(e) => setShorthandConnection((prev) => ({ ...prev, user: e.target.value }))}
                  placeholder="User (required)"
                  style={inputStyle}
                />
                <input
                  value={shorthandConnection.password}
                  onChange={(e) => setShorthandConnection((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="Password (required)"
                  type="password"
                  style={inputStyle}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)' }}
                  onClick={() => setShowShorthandOptional((prev) => !prev)}
                >
                  {showShorthandOptional ? '收起端口/库名' : '展开端口/库名'}
                </button>
              </div>
              {showShorthandOptional && (
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10, marginBottom: 8 }}>
                  <input
                    value={shorthandConnection.port}
                    onChange={(e) => setShorthandConnection((prev) => ({ ...prev, port: e.target.value }))}
                    placeholder={getDialectDefaults(migrationDialect).port}
                    style={inputStyle}
                  />
                  <input
                    value={shorthandConnection.database}
                    onChange={(e) => setShorthandConnection((prev) => ({ ...prev, database: e.target.value }))}
                    placeholder={getDialectDefaults(migrationDialect).database}
                    style={inputStyle}
                  />
                </div>
              )}
              <code style={{ display: 'block', padding: '10px 14px', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-light)' }}>
                {generatedConnectionString || 'Fill host/user/password to generate connection string'}
              </code>
            </div>
          )}

          {migrationDialect !== 'sqlite' && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                checked={migrationSsl}
                onChange={(e) => setMigrationSsl(e.target.checked)}
                style={{ width: 14, height: 14, accentColor: 'var(--color-primary)' }}
              />
              启用 SSL/TLS 加密连接
            </label>
          )}

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <input
              type="checkbox"
              checked={migrationOverwrite}
              onChange={(e) => setMigrationOverwrite(e.target.checked)}
              style={{ width: 14, height: 14, accentColor: 'var(--color-primary)' }}
            />
            允许覆盖目标数据库现有数据
          </label>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button
              onClick={handleTestExternalDatabaseConnection}
              disabled={testingMigrationConnection || migratingDatabase || savingRuntimeDatabase}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              {testingMigrationConnection ? <><span className="spinner spinner-sm" /> 测试中...</> : '测试连接'}
            </button>
            <button
              onClick={handleMigrateToExternalDatabase}
              disabled={migratingDatabase || testingMigrationConnection || savingRuntimeDatabase}
              className="btn btn-primary"
            >
              {migratingDatabase ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 迁移中...</> : '开始迁移'}
            </button>
            <button
              onClick={handleSaveRuntimeDatabaseConfig}
              disabled={savingRuntimeDatabase || migratingDatabase || testingMigrationConnection}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              {savingRuntimeDatabase ? <><span className="spinner spinner-sm" /> 保存中...</> : '保存为运行数据库（重启后生效）'}
            </button>
          </div>

          {runtimeDatabaseState && (
            <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', padding: 10, fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.8, marginBottom: migrationSummary ? 12 : 0 }}>
              <div>当前运行：{runtimeDatabaseState.active.dialect}（{runtimeDatabaseState.active.connection || '(empty)' }）{runtimeDatabaseState.active.ssl && ' [SSL]'}</div>
              <div>
                已保存待生效：
                {runtimeDatabaseState.saved
                  ? ` ${runtimeDatabaseState.saved.dialect}（${runtimeDatabaseState.saved.connection}）${runtimeDatabaseState.saved.ssl ? ' [SSL]' : ''}`
                  : ' 未保存'}
              </div>
              {runtimeDatabaseState.restartRequired && (
                <div style={{ color: 'var(--color-warning)' }}>检测到待生效数据库配置，请重启容器使其生效。</div>
              )}
            </div>
          )}

          {migrationSummary && (
            <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', padding: 10, fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
              <div>目标：{migrationSummary.dialect}（{migrationSummary.connection}）</div>
              <div>版本：{migrationSummary.version}，时间：{new Date(migrationSummary.timestamp).toLocaleString()}</div>
              <div>迁移结果：站点 {migrationSummary.rows.sites} / 账号 {migrationSummary.rows.accounts} / 令牌 {migrationSummary.rows.accountTokens} / 路由 {migrationSummary.rows.tokenRoutes} / 通道 {migrationSummary.rows.routeChannels} / 设置 {migrationSummary.rows.settings}</div>
            </div>
          )}
        </div>

        <div style={{ order: 0, gridColumn: '1 / -1' }}><UpdateCenterSection /></div>



        <div className="card animate-slide-up stagger-7" style={{ padding: 20, order: 10, border: '1px solid color-mix(in srgb, var(--color-danger) 30%, var(--color-border))' }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10, color: 'var(--color-danger)' }}>危险操作</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.8, marginBottom: 12 }}>
            重新初始化系统会清空当前 metapi 使用中的全部数据库内容；若当前运行在外部 MySQL/Postgres，也会先清空该外部库中的 metapi 数据，然后切回默认 SQLite。
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.8, marginBottom: 14 }}>
            完成后管理员 Token 保留当前值不变，页面将自动刷新并恢复登录态。
          </div>
          <button onClick={() => setFactoryResetOpen(true)} className="btn btn-danger">
            重新初始化系统
          </button>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            <button onClick={handleClearCache} disabled={clearingCache} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
              {clearingCache ? <><span className="spinner spinner-sm" /> 清理中...</> : '清除缓存并重建路由'}
            </button>
            <button onClick={handleClearUsage} disabled={clearingUsage} className="btn btn-link btn-link-warning">
              {clearingUsage ? <><span className="spinner spinner-sm" /> 清理中...</> : '清除占用与使用日志'}
            </button>
          </div>
        </div>

        <div className="card animate-slide-up stagger-7" style={{ padding: 20, order: 9 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>会话与安全</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            登录会话默认 12 小时自动过期。可选配置管理端 IP 白名单，支持每行一个 IP 或 IPv4 CIDR 网段。
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
            公网隧道控制台访问开关已移到本页顶部「公网隧道访问」，仪表盘隧道卡片也可直接切换。
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
            当前识别到的管理端 IP（由服务端判定）：
          </div>
          <code style={{ display: 'block', padding: '10px 14px', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-light)', marginBottom: 10 }}>
            {runtime.currentAdminIp || '未知'}
          </code>
          <textarea
            value={adminIpAllowlistText}
            disabled={isTunnelClientView}
            onChange={(e) => setAdminIpAllowlistText(e.target.value)}
            placeholder={'例如：\n127.0.0.1\n192.168.1.10\n192.168.1.0/24'}
            rows={4}
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)', resize: 'vertical', marginBottom: 10 }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={saveSecuritySettings} disabled={savingSecurity || isTunnelClientView} className="btn btn-primary">
              {savingSecurity ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存安全设置'}
            </button>
            <button
              onClick={() => {
                clearAuthSession(localStorage);
                window.location.reload();
              }}
              className="btn btn-danger"
            >
              退出登录
            </button>
          </div>
        </div>

        <div className="card animate-slide-up stagger-7" style={{ padding: 20, order: 11 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>反探测（敏感词检测）</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
            用于伪装成内容审核以拦截探活请求。开启后，短文本（低于下方阈值）的非继续对话请求会被 400 拦截；多轮对话中的简短后续消息不受影响。可在每个下游 Key 上单独覆盖。
          </div>
          {isTunnelClientView && (
            <div style={{ fontSize: 12, color: 'var(--color-warning)', marginBottom: 12 }}>
              通过公网隧道时不允许修改安全设置。
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                disabled={isTunnelClientView}
                checked={runtime.sensitiveWordDetectionEnabled}
                onChange={(e) => setRuntime((prev) => ({ ...prev, sensitiveWordDetectionEnabled: e.target.checked }))}
              />
              启用敏感词检测（反探活）
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              短文本阈值
              <input
                type="number"
                min={1}
                max={64}
                disabled={isTunnelClientView}
                value={runtime.antiProbeMinTextLength}
                onChange={(e) => setRuntime((prev) => ({
                  ...prev,
                  antiProbeMinTextLength: Math.max(1, Math.min(64, Math.trunc(Number(e.target.value) || 1))),
                }))}
                style={{ ...inputStyle, width: 80 }}
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={saveAntiProbeSettings} disabled={savingSecurity || isTunnelClientView} className="btn btn-primary">
              {savingSecurity ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存反探测设置'}
            </button>
          </div>
        </div>
      </div>
      <FactoryResetModal
        presence={factoryResetPresence}
        factoryResetting={factoryResetting}
        factoryResetSecondsLeft={factoryResetSecondsLeft}
        adminToken={FACTORY_RESET_ADMIN_TOKEN}
        onClose={closeFactoryResetModal}
        onConfirm={handleFactoryReset}
      />
    </div>
  );
}
