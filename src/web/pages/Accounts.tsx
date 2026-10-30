import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import CenteredModal from '../components/CenteredModal.js';
import ResponsiveFilterPanel from '../components/ResponsiveFilterPanel.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { pageForItemIndex } from '../components/clientPagination.js';
import PaginationControls from '../components/PaginationControls.js';
import { useClientPagination } from '../components/useClientPagination.js';
import { usePersistedPageSize } from '../components/usePersistedPageSize.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.js';
import SiteBadgeLink from '../components/SiteBadgeLink.js';
import { StatusToggle } from '../components/StatusToggle.js';
import AccountModelsModal from './accounts/AccountModelsModal.js';
import EditAccountModal from './accounts/EditAccountModal.js';
import {
  buildAddAccountPrereqHint,
  buildVerifyFailureHint,
  normalizeVerifyFailureMessage,
} from './helpers/accountVerifyFeedback.js';
import {
  formatSub2ApiUsageInline,
  isTruthyFlag,
  parsePositiveInt,
  parseSub2ApiAccountUsage,
  resolveAccountCredentialMode,
} from './helpers/accountConnection.js';
import {
  clearFocusParams,
  readFocusAccountIntent,
} from './helpers/navigationFocus.js';
import { TokensPanel } from './tokens/TokensPanel.js';
import { tr } from '../i18n.js';
import {
  buildCustomDragReorderUpdates,
  sortItemsForDisplay,
  type SortMode,
} from './helpers/listSorting.js';
import { SITE_DOCS_URL } from '../docsLink.js';
import { getSiteInitializationPreset } from '../../shared/siteInitializationPresets.js';
import { parseBatchApiKeys } from '../../shared/apiKeyBatch.js';
import { StatusPill, StatusText } from '../components/StatusText.js';
import { SortableAccountMobileCard, SortableAccountTableRow } from './accounts/SortableAccountItems.js';
import AccountRebindModal from './accounts/AccountRebindModal.js';

type ConnectionsSegment = 'session' | 'apikey' | 'tokens';

const ACCOUNT_SEGMENTS: Array<{
  value: ConnectionsSegment;
  label: string;
  tooltip: string;
  tooltipSide: 'top' | 'bottom';
  tooltipAlign: 'start' | 'center' | 'end';
}> = [
  {
    value: 'session',
    label: tr('账号管理'),
    tooltip: tr('用于签到、余额、状态维护'),
    tooltipSide: 'bottom',
    tooltipAlign: 'start',
  },
  {
    value: 'apikey',
    label: tr('API Key管理'),
    tooltip: tr('只有 Base URL + Key 时使用，只负责代理调用'),
    tooltipSide: 'bottom',
    tooltipAlign: 'center',
  },
  {
    value: 'tokens',
    label: tr('账号令牌管理'),
    tooltip: tr('从账号同步或手动维护，供路由实际调用'),
    tooltipSide: 'bottom',
    tooltipAlign: 'end',
  },
];

const SITE_SELECT_SEARCH_PLACEHOLDER = tr('筛选站点（名称 / 平台 / URL）');

function createLoginForm() {
  return { siteId: 0, username: '', password: '' };
}

function createTokenForm(credentialMode: 'session' | 'apikey' = 'session') {
  return {
    siteId: 0,
    username: '',
    accessToken: '',
    platformUserId: '',
    refreshToken: '',
    tokenExpiresAt: '',
    credentialMode,
    skipModelFetch: false,
  };
}

function createRebindForm(platformUserId = '') {
  return {
    accessToken: '',
    platformUserId,
    refreshToken: '',
    tokenExpiresAt: '',
  };
}

function resolveConnectionsSegment(search: string): ConnectionsSegment {
  const rawSegment = new URLSearchParams(search).get('segment');
  if (rawSegment === 'apikey' || rawSegment === 'tokens') return rawSegment;
  return 'session';
}

type AccountsProps = {
  siteId?: number;
};

export default function Accounts({ siteId: filterSiteId }: AccountsProps = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const activeSegment = useMemo(
    () => resolveConnectionsSegment(location.search),
    [location.search],
  );
  const [accounts, setAccounts] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('custom');
  const [activeDragAccountId, setActiveDragAccountId] = useState<number | null>(null);
  const [overDragAccountId, setOverDragAccountId] = useState<number | null>(null);
  const [highlightAccountId, setHighlightAccountId] = useState<number | null>(
    null,
  );
  const [expandedAccountIds, setExpandedAccountIds] = useState<number[]>([]);
  const isMobile = useIsMobile();
  // 与站点管理同一套传感器：鼠标位移 6px 或触屏长按 180ms 才开始拖拽，
  // 这样行内的「置顶/编辑/删除」等按钮仍然是正常点击。
  const accountSortSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [showMobileTools, setShowMobileTools] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<'token' | 'login'>('token');
  const [loginForm, setLoginForm] = useState(createLoginForm);
  const [tokenForm, setTokenForm] = useState(() => createTokenForm('session'));
  const [createIntentPresetId, setCreateIntentPresetId] = useState<
    string | null
  >(null);
  const [applyCreatePresetModels, setApplyCreatePresetModels] = useState(false);
  const [verifyResult, setVerifyResult] = useState<any>(null);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [embeddedTokenActions, setEmbeddedTokenActions] =
    useState<React.ReactNode>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<null | {
    mode: 'single';
    accountId?: number;
    accountName?: string;
  }>(null);
  const [editingAccount, setEditingAccount] = useState<any | null>(null);
  const [rebindTarget, setRebindTarget] = useState<any | null>(null);
  const [rebindForm, setRebindForm] = useState(() => createRebindForm());
  const [rebindVerifyResult, setRebindVerifyResult] = useState<any>(null);
  const [rebindVerifying, setRebindVerifying] = useState(false);
  const [rebindSaving, setRebindSaving] = useState(false);
  const [modelModal, setModelModal] = useState<{
    open: boolean;
    account: any | null;
    models: Array<{
      name: string;
      latencyMs: number | null;
      disabled: boolean;
      isManual?: boolean;
    }>;
    pendingDisabled: Set<string>;
    newModelPolicy: 'auto' | 'disable';
    loading: boolean;
    saving: boolean;
    siteName: string;
    manualModelsInput: string;
    addingManualModels: boolean;
    removingManualModelName: string | null;
  }>({
    open: false,
    account: null,
    models: [],
    pendingDisabled: new Set(),
    newModelPolicy: 'auto',
    loading: false,
    saving: false,
    siteName: '',
    manualModelsInput: '',
    addingManualModels: false,
    removingManualModelName: null,
  });
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const accountsTableWrapRef = useRef<HTMLDivElement | null>(null);
  const accountsMobileListRef = useRef<HTMLDivElement | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRebindTargetRef = useRef<any | null>(null);
  const modelModalRequestSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const toast = useToast();
  if (rebindTarget) lastRebindTargetRef.current = rebindTarget;
  const activeRebindTarget = rebindTarget || lastRebindTargetRef.current;
  const isRebindSub2Api =
    (activeRebindTarget?.site?.platform || '').toLowerCase() === 'sub2api';

  const load = async (forceRefresh = false) => {
    try {
      const snapshot = await api.getAccountsSnapshot(
        forceRefresh ? { refresh: true } : undefined,
      );
      const nextAccounts = Array.isArray(snapshot?.accounts)
        ? snapshot.accounts
        : [];
      const nextSites = Array.isArray(snapshot?.sites) ? snapshot.sites : [];
      setAccounts(nextAccounts);
      setSites(nextSites);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(errorMessage || tr('加载账号列表失败'));
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    void load();
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const selectedTokenSite = useMemo(
    () => sites.find((item) => item.id === tokenForm.siteId) || null,
    [sites, tokenForm.siteId],
  );
  const parsedApiKeys = useMemo(
    () =>
      activeSegment === 'apikey'
        ? parseBatchApiKeys(tokenForm.accessToken)
        : [],
    [activeSegment, tokenForm.accessToken],
  );
  const isBatchApiKeyInput =
    activeSegment === 'apikey' && parsedApiKeys.length > 1;
  const siteSelectOptions = useMemo(
    () => [
      { value: '0', label: tr('选择站点') },
      ...sites.map((site: any) => ({
        value: String(site.id),
        label: `${site.name} (${site.platform})`,
        description: site.url || undefined,
      })),
    ],
    [sites],
  );
  const isSub2ApiSelected =
    (selectedTokenSite?.platform || '').toLowerCase() === 'sub2api';
  // 只有 new-api / one-api 系在验证/拉模型时需要 New-Api-User 用户 ID；
  // sub2api 等 JWT 鉴权平台填了也不生效，输入框按平台隐藏。
  const platformRequiresUserId = (platform?: string) => {
    const normalized = (platform || '').toLowerCase();
    return normalized === 'new-api' || normalized === 'one-api';
  };
  // Only platforms whose adapters really implement username/password login
  // (POST /api/user/login) get the login tab; metapi (admin token / sk- key
  // only), sub2api (JWT) and the token-based providers hide it.
  const platformSupportsPasswordLogin = (platform?: string) => {
    const normalized = (platform || '').toLowerCase();
    return normalized === 'new-api' || normalized === 'one-api';
  };
  const selectedSiteSupportsLogin =
    platformSupportsPasswordLogin(selectedTokenSite?.platform);
  const activeAddCredentialMode =
    activeSegment === 'apikey' ? 'apikey' : 'session';
  const createIntentPreset = useMemo(
    () => getSiteInitializationPreset(createIntentPresetId),
    [createIntentPresetId],
  );

  const resetAddForms = (
    credentialMode: 'session' | 'apikey' = activeAddCredentialMode,
  ) => {
    const currentSiteId = filterSiteId || 0;
    setAddMode('token');
    setLoginForm({ ...createLoginForm(), siteId: currentSiteId });
    setTokenForm({ ...createTokenForm(credentialMode), siteId: currentSiteId });
    setCreateIntentPresetId(null);
    setApplyCreatePresetModels(false);
    setVerifyResult(null);
  };

  const closeAddPanel = () => {
    setShowAdd(false);
    setVerifying(false);
    setSaving(false);
    resetAddForms();
  };

  const resolveAccountDisplayName = (account: any) => {
    const username =
      typeof account?.username === 'string' ? account.username.trim() : '';
    if (username) return username;
    return resolveAccountCredentialMode(account) === 'apikey'
      ? tr('API Key 连接')
      : tr('未命名');
  };

  const sortedAccounts = useMemo(
    () =>
      sortItemsForDisplay(
        accounts,
        sortMode,
        (account) => account.balance || 0,
      ),
    [accounts, sortMode],
  );
  const visibleAccounts = useMemo(() => {
    if (activeSegment === 'tokens') return [];
    return sortedAccounts.filter((account) => {
      if (filterSiteId && account.siteId !== filterSiteId && account.site?.id !== filterSiteId) {
        return false;
      }
      return resolveAccountCredentialMode(account) === activeSegment;
    });
  }, [activeSegment, sortedAccounts, filterSiteId]);
  const [exactPageSize, setExactPageSize] = usePersistedPageSize('accounts');
  const {
    page: safePage,
    setPage,
    totalPages,
    pageSize,
    pagedItems: pagedAccounts,
    showControls: showAccountPagination,
  } = useClientPagination(
    visibleAccounts,
    `${activeSegment}:${sortMode}:${accounts.length}:${filterSiteId || 0}`,
    exactPageSize,
  );
  /** 拖拽排序的候选集合 —— 当前页的行，与站点管理同一套 DndContext 约定。 */
  const sortableContextItems = useMemo(
    () => pagedAccounts.map((a: any) => a.id),
    [pagedAccounts],
  );
  const verifyFailureHint = buildVerifyFailureHint(verifyResult);
  const addAccountPrereqHint = buildAddAccountPrereqHint(verifyResult);

  const setSegment = (nextSegment: ConnectionsSegment) => {
    const params = new URLSearchParams(location.search);
    if (nextSegment === 'session') params.delete('segment');
    else params.set('segment', nextSegment);
    const nextSearch = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : '',
      },
      // 透传 state：从站点列表进入时的 fromSearch 必须保留，
      // 否则切换段后返回按钮丢失来源页码（回到 /sites 第 1 页）。
      { replace: false, state: location.state },
    );
  };

  useEffect(() => {
    if (activeSegment !== 'tokens') return;
    closeAddPanel();
    if (rebindTarget) closeRebindPanel();
    setEditingAccount(null);
  }, [activeSegment]);

  useEffect(() => {
    if (activeSegment === 'tokens') return;
    setEmbeddedTokenActions(null);
  }, [activeSegment]);

  useEffect(() => {
    if (activeSegment === 'tokens' || !loaded) return;
    const params = new URLSearchParams(location.search);
    const shouldOpenCreate = isTruthyFlag(params.get('create'));
    const requestedSiteId = parsePositiveInt(params.get('siteId'));
    if (!shouldOpenCreate || !requestedSiteId) return;

    const credentialMode = activeSegment === 'apikey' ? 'apikey' : 'session';
    const initializationPreset = getSiteInitializationPreset(
      params.get('initPreset'),
    );
    setShowAdd(true);
    setAddMode('token');
    setVerifyResult(null);
    setCreateIntentPresetId(initializationPreset?.id || null);
    setApplyCreatePresetModels(
      Boolean(initializationPreset?.recommendedModels?.length),
    );
    setLoginForm({ ...createLoginForm(), siteId: requestedSiteId });
    setTokenForm({
      ...createTokenForm(credentialMode),
      siteId: requestedSiteId,
      skipModelFetch:
        credentialMode === 'apikey' &&
        initializationPreset?.recommendedSkipModelFetch === true,
    });
    // Refresh snapshot so the selected new site is present in siteSelectOptions.
    void load(true);

    params.delete('create');
    params.delete('siteId');
    params.delete('from');
    params.delete('initPreset');
    const nextSearch = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : '',
      },
      { replace: true, state: location.state },
    );
  }, [activeSegment, loaded, location.pathname, location.search, navigate]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  const handleLoginAdd = async () => {
    if (!loginForm.siteId || !loginForm.username || !loginForm.password) return;
    setSaving(true);
    try {
      const result = await api.loginAccount(loginForm);
      if (result.success) {
        closeAddPanel();
        const msg = result.apiTokenFound
          ? `账号 "${loginForm.username}" 已添加，API Key 已自动获取`
          : `账号 "${loginForm.username}" 已添加（未找到 API Key，请手动设置）`;
        toast.success(msg);
        load(true);
      } else {
        toast.error(result.message || tr('登录失败'));
      }
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('登录请求失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleVerifyToken = async () => {
    if (!tokenForm.siteId) return;
    if (activeSegment !== 'apikey' && !tokenForm.accessToken) return;
    if (isBatchApiKeyInput) {
      toast.info(
        `检测到 ${parsedApiKeys.length} 个 API Key，批量模式会在添加时逐条校验`,
      );
      return;
    }
    const credentialMode = activeSegment === 'apikey' ? 'apikey' : 'session';
    setVerifying(true);
    setVerifyResult(null);
    try {
      const result = await api.verifyToken({
        siteId: tokenForm.siteId,
        accessToken: tokenForm.accessToken,
        platformUserId: tokenForm.platformUserId
          ? parseInt(tokenForm.platformUserId)
          : undefined,
        credentialMode,
      });
      setVerifyResult(result);
      if (result.success) {
        if (result.tokenType === 'apikey') {
          toast.success(
            `API Key 验证成功（可用模型 ${result.modelCount || 0} 个）`,
          );
        } else {
          toast.success(
            `Session 验证成功: ${result.userInfo?.username || tr('未知用户')}`,
          );
        }
      } else {
        toast.error(
          normalizeVerifyFailureMessage(result.message || tr('Token 无效')),
        );
      }
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(normalizeVerifyFailureMessage(eMessage));
      setVerifyResult({ success: false, message: eMessage });
    } finally {
      setVerifying(false);
    }
  };

  const handleTokenAdd = async () => {
    if (!tokenForm.siteId) return;
    if (activeSegment !== 'apikey' && !tokenForm.accessToken) return;
    if (
      !isBatchApiKeyInput &&
      !verifyResult?.success &&
      !tokenForm.skipModelFetch
    ) {
      toast.error(tr('请先验证 Token 成功后再添加账号'));
      return;
    }
    const credentialMode = activeSegment === 'apikey' ? 'apikey' : 'session';
    const initializationPreset = createIntentPreset;
    setSaving(true);
    try {
      const result = await api.addAccount({
        siteId: tokenForm.siteId,
        username: tokenForm.username.trim() || undefined,
        accessToken: tokenForm.accessToken,
        accessTokens: isBatchApiKeyInput ? parsedApiKeys : undefined,
        platformUserId: tokenForm.platformUserId
          ? parseInt(tokenForm.platformUserId)
          : undefined,
        refreshToken:
          isSub2ApiSelected && tokenForm.refreshToken.trim()
            ? tokenForm.refreshToken.trim()
            : undefined,
        tokenExpiresAt:
          isSub2ApiSelected && tokenForm.tokenExpiresAt.trim()
            ? Number.parseInt(tokenForm.tokenExpiresAt.trim(), 10)
            : undefined,
        credentialMode,
        skipModelFetch: tokenForm.skipModelFetch,
      });
      if (result?.batch) {
        closeAddPanel();
        const createdCount = Number(result.createdCount) || 0;
        const failedCount = Number(result.failedCount) || 0;
        if (createdCount > 0) {
          toast.success(
            `批量添加完成：成功 ${createdCount}，失败 ${failedCount}`,
          );
        }
        const failedItems = Array.isArray(result.items)
          ? result.items.filter((item: any) => item?.status === 'failed')
          : [];
        if (failedItems.length > 0) {
          const firstMessage = failedItems[0]?.message || tr('创建失败');
          toast.error(`失败 ${failedItems.length} 条：${firstMessage}`);
        }
        load(true);
        return;
      }
      let seededRecommendedModels = false;
      const recommendedModels = initializationPreset?.recommendedModels || [];
      const createdAccountId = Number(result?.id) || 0;
      const shouldSeedRecommendedModels =
        credentialMode === 'apikey' &&
        tokenForm.skipModelFetch &&
        applyCreatePresetModels &&
        recommendedModels.length > 0 &&
        createdAccountId > 0;
      if (shouldSeedRecommendedModels) {
        try {
          await api.addAccountAvailableModels(
            createdAccountId,
            recommendedModels,
          );
          seededRecommendedModels = true;
        } catch (seedErr) {
          const seedErrMessage = seedErr instanceof Error ? seedErr.message : String(seedErr);
          toast.error(seedErrMessage || tr('连接已添加，但推荐模型补录失败'));
        }
      }
      closeAddPanel();
      if (result.queued) {
        toast.info(result.message || tr('账号已添加，后台正在同步初始化信息。'));
        const jobId = typeof result.jobId === 'string' ? result.jobId : '';
        if (jobId) {
          // Poll init task so runtime health flips from "未知" without manual refresh.
          // Guarded by mountedRef: never setState after unmount.
          void (async () => {
            const startedAt = Date.now();
            while (mountedRef.current && Date.now() - startedAt < 90_000) {
              try {
                const task: any = await api.getTask(jobId);
                const status = String(task?.status || task?.task?.status || '');
                if (status === 'succeeded' || status === 'failed') {
                  if (mountedRef.current) load(true);
                  return;
                }
              } catch {
                // ignore transient poll errors
              }
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            if (mountedRef.current) load(true);
          })();
        }
      } else if (result.tokenType === 'apikey') {
        toast.success(tr('已添加为 API Key 账号（可用于代理转发）'));
      } else {
        const parts: string[] = [];
        if (result.usernameDetected) parts.push(tr('用户名已自动识别'));
        if (result.apiTokenFound) parts.push(tr('API Key 已自动获取'));
        const extra = parts.length ? `（${parts.join('，')}）` : '';
        toast.success(`账号已添加${extra}`);
      }
      if (seededRecommendedModels) {
        toast.success(
          `已补入 ${recommendedModels.length} 个推荐模型并重建路由`,
        );
      }
      load(true);
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('添加失败'));
    } finally {
      setSaving(false);
    }
  };

  const withLoading = async (
    key: string,
    fn: () => Promise<any>,
    successMsg?: string,
  ) => {
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await fn();
      if (successMsg) toast.success(successMsg);
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('操作失败'));
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
      void load(true);
    }
  };

  const applyLoadedModelModal = (account: any, result: any) => {
    const models = Array.isArray(result?.models) ? result.models : [];
    const disabledSet = new Set<string>(
      models.filter((m: any) => m.disabled).map((m: any) => m.name as string),
    );
    setModelModal((s) => ({
      ...s,
      loading: false,
      models,
      pendingDisabled: disabledSet,
      newModelPolicy: result?.newModelPolicy === 'disable' ? 'disable' : 'auto',
      siteName: result?.siteName || account.site?.name || s.siteName,
    }));
  };

  const loadModelModalModels = async (
    account: any,
    options: {
      refreshUpstream?: boolean;
      resetBeforeLoad?: boolean;
      closeOnError?: boolean;
      successMessage?: string | null;
      errorMessage?: string;
    } = {},
  ) => {
    const requestId = ++modelModalRequestSeqRef.current;
    setModelModal((s) => ({
      ...s,
      open: true,
      account,
      loading: true,
      ...(options.resetBeforeLoad
        ? {
            models: [],
            pendingDisabled: new Set<string>(),
            siteName: '',
            manualModelsInput: '',
          }
        : {}),
    }));
    try {
      if (options.refreshUpstream) {
        await api.checkModels(account.id);
      }
      const result = await api.getAccountModels(account.id);
      if (modelModalRequestSeqRef.current !== requestId) return;
      applyLoadedModelModal(account, result);
      if (options.successMessage) {
        toast.success(options.successMessage);
      }
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      if (modelModalRequestSeqRef.current !== requestId) return;
      toast.error(eMessage || options.errorMessage || tr('加载模型列表失败'));
      setModelModal((s) =>
        options.closeOnError
          ? { ...s, open: false, account: null, loading: false }
          : { ...s, loading: false },
      );
    }
  };

  const openModelModal = async (account: any) => {
    await loadModelModalModels(account, {
      resetBeforeLoad: true,
      closeOnError: true,
      errorMessage: tr('加载模型列表失败'),
    });
  };

  const closeModelModal = () => {
    modelModalRequestSeqRef.current += 1;
    setModelModal((s) => ({
      ...s,
      open: false,
      account: null,
      manualModelsInput: '',
      addingManualModels: false,
    }));
  };

  const toggleModelDisabled = (modelName: string) => {
    setModelModal((s) => {
      const next = new Set(s.pendingDisabled);
      if (next.has(modelName)) next.delete(modelName);
      else next.add(modelName);
      return { ...s, pendingDisabled: next };
    });
  };

  const saveModelDisabled = async () => {
    if (!modelModal.account) return;
    const accountId = modelModal.account.id;
    setModelModal((s) => ({ ...s, saving: true }));
    try {
      await api.updateAccountDisabledModels(
        accountId,
        Array.from(modelModal.pendingDisabled),
        modelModal.newModelPolicy,
      );
      try {
        await api.rebuildRoutes(false, false);
        toast.success(tr('模型禁用设置已保存，路由已重建'));
      } catch {
        toast.error(tr('模型禁用设置已保存，但路由重建失败，请手动刷新路由'));
      }
      closeModelModal();
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('保存失败'));
    } finally {
      setModelModal((s) => ({ ...s, saving: false }));
    }
  };

  const handleAddManualModels = async () => {
    if (!modelModal.account || !modelModal.manualModelsInput.trim()) return;
    const modelsToAdd = modelModal.manualModelsInput
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    if (modelsToAdd.length === 0) return;

    setModelModal((s) => ({ ...s, addingManualModels: true }));
    try {
      const res = await api.addAccountAvailableModels(
        modelModal.account.id,
        modelsToAdd,
      );
      if (res.success) {
        toast.success(tr('模型已手动添加'));
        setModelModal((s) => ({ ...s, manualModelsInput: '' }));
        await loadModelModalModels(modelModal.account, {
          refreshUpstream: false,
        });
      } else {
        toast.error(res.message || tr('手动添加模型失败'));
      }
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('手动添加模型失败'));
    } finally {
      setModelModal((s) => ({ ...s, addingManualModels: false }));
    }
  };

  const handleRemoveManualModel = async (modelName: string) => {
    if (!modelModal.account || modelModal.removingManualModelName !== null) return;

    setModelModal((s) => ({ ...s, removingManualModelName: modelName }));
    try {
      const res = await api.removeAccountManualModels(
        modelModal.account.id,
        [modelName],
      );
      if (res.success) {
        toast.success(`已删除手动模型 ${modelName}`);
        await loadModelModalModels(modelModal.account, {
          refreshUpstream: false,
        });
      } else {
        toast.error(res.message || tr('删除手动模型失败'));
      }
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('删除手动模型失败'));
    } finally {
      setModelModal((s) => ({ ...s, removingManualModelName: null }));
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    outline: 'none',
    background: 'var(--color-bg-inset)',
    color: 'var(--color-text-primary)',
  };

  const runtimeHealthMap: Record<
    string,
    {
      label: string;
      cls: string;
      dotClass: string;
      pulse: boolean;
    }
  > = {
    healthy: {
      label: tr('健康'),
      cls: 'badge-success',
      dotClass: 'status-dot-success',
      pulse: true,
    },
    unhealthy: {
      label: tr('异常'),
      cls: 'badge-error',
      dotClass: 'status-dot-error',
      pulse: true,
    },
    degraded: {
      label: tr('降级'),
      cls: 'badge-warning',
      dotClass: 'status-dot-pending',
      pulse: true,
    },
    disabled: {
      label: tr('已禁用'),
      cls: 'badge-muted',
      dotClass: 'status-dot-muted',
      pulse: false,
    },
    unknown: {
      label: tr('未知'),
      cls: 'badge-muted',
      dotClass: 'status-dot-pending',
      pulse: false,
    },
  };

  const resolveRuntimeHealth = (account: any) => {
    if (account.status === 'expired') {
      return {
        ...runtimeHealthMap.unhealthy,
        label: tr('已过期'),
        reason: account.runtimeHealth?.reason || tr('连接凭证已过期，请更新凭证'),
      };
    }
    const capabilities = resolveAccountCapabilities(account);
    const fallbackState =
      account.status === 'disabled' || account.site?.status === 'disabled'
        ? 'disabled'
        : !capabilities.proxyOnly && account.status === 'expired'
          ? 'unhealthy'
          : 'unknown';
    const state = account.runtimeHealth?.state || fallbackState;
    const cfg = runtimeHealthMap[state] || runtimeHealthMap.unknown;
    const reason =
      account.runtimeHealth?.reason ||
      (state === 'disabled'
        ? tr('账号或站点已禁用')
        : state === 'unhealthy'
          ? tr('最近健康检查失败')
          : tr('尚未获取运行健康信息'));
    return { state, reason, ...cfg };
  };

  const resolveAccountCapabilities = (account: any) => {
    const fromServer = account?.capabilities;
    if (fromServer && typeof fromServer === 'object') {
      return {
        canCheckin: !!fromServer.canCheckin,
        canRefreshBalance: !!fromServer.canRefreshBalance,
        proxyOnly: !!fromServer.proxyOnly,
      };
    }
    const hasSession =
      typeof account?.accessToken === 'string' &&
      account.accessToken.trim().length > 0;
    return {
      canCheckin: hasSession,
      canRefreshBalance: hasSession,
      proxyOnly: !hasSession,
    };
  };

  const handleRefreshRuntimeHealth = async () => {
    setActionLoading((s) => ({ ...s, 'health-refresh': true }));
    try {
      const res = await api.refreshAccountHealth();
      if (res?.queued) {
        toast.info(res.message || tr('账号状态刷新任务已提交，完成后会自动更新。'));
      } else {
        toast.success(res?.message || tr('账号状态已刷新'));
      }
      load(true);
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('刷新账号状态失败'));
    } finally {
      setActionLoading((s) => ({ ...s, 'health-refresh': false }));
    }
  };

  const handleToggleCheckin = async (account: any) => {
    const key = `checkin-toggle-${account.id}`;
    const nextEnabled = !account.checkinEnabled;
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await api.updateAccount(account.id, { checkinEnabled: nextEnabled });
      toast.success(
        nextEnabled ? tr('已开启签到') : tr('已关闭签到（全部签到会忽略此账号）'),
      );
      load(true);
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('切换签到状态失败'));
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const handleTogglePin = async (account: any) => {
    const key = `pin-toggle-${account.id}`;
    const nextPinned = !account.isPinned;
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await api.updateAccount(account.id, { isPinned: nextPinned });
      toast.success(nextPinned ? tr('账号已置顶') : tr('账号已取消置顶'));
      load(true);
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('切换账号置顶失败'));
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const clearAccountDragState = () => {
    setActiveDragAccountId(null);
    setOverDragAccountId(null);
    if (typeof document !== 'undefined') {
      document.body.classList.remove('site-drag-active');
    }
  };

  const handleAccountDragStart = (event: DragStartEvent) => {
    const accountId = Number(event.active.id);
    setActiveDragAccountId(Number.isFinite(accountId) ? accountId : null);
    setOverDragAccountId(Number.isFinite(accountId) ? accountId : null);
    if (typeof document !== 'undefined') {
      document.body.classList.add('site-drag-active');
    }
  };

  const handleAccountDragOver = (event: DragOverEvent) => {
    const overId = event.over ? Number(event.over.id) : null;
    setOverDragAccountId(overId != null && Number.isFinite(overId) ? overId : null);
  };

  /**
   * 拖拽落位：算出受影响账号的新 sortOrder 后逐条落库，再整表重载 —— 与站点管理
   * `handleSiteDragEnd` 同一条路径。置顶 / 普通 / 已禁用是三个连续分组，跨组拖拽
   * 会被拒绝并给出提示（`buildCustomDragReorderUpdates` 本身也会返回空）。
   */
  const handleAccountDragEnd = async (event: DragEndEvent) => {
    const activeId = Number(event.active.id);
    const overId = event.over ? Number(event.over.id) : null;
    clearAccountDragState();
    if (!Number.isFinite(activeId) || overId == null || !Number.isFinite(overId)) return;
    if (activeId === overId) return;

    const active = accounts.find((item: any) => item.id === activeId);
    const over = accounts.find((item: any) => item.id === overId);
    if (!active || !over) return;
    if (
      !!active.isPinned !== !!over.isPinned
      || (active.status === 'disabled') !== (over.status === 'disabled')
    ) {
      toast.info(tr('置顶、普通和禁用账号需在各自分组内排序'));
      return;
    }

    const updates = buildCustomDragReorderUpdates(accounts, activeId, overId);
    if (updates.length === 0) return;

    const key = `reorder-${activeId}`;
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await Promise.all(
        updates.map((update) =>
          api.updateAccount(update.id, { sortOrder: update.sortOrder }),
        ),
      );
      load(true);
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('更新账号排序失败'));
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const parseAccountExtraConfig = (account: any): Record<string, any> => {
    try {
      return JSON.parse(account?.extraConfig || '{}') || {};
    } catch {
      return {};
    }
  };

  const openEditPanel = (account: any) => {
    closeAddPanel();
    setRebindTarget(null);
    setEditingAccount(account);
  };

  const closeEditPanel = () => {
    setEditingAccount(null);
  };

  const toggleAccountDetails = (accountId: number) => {
    setExpandedAccountIds((current) =>
      current.includes(accountId)
        ? current.filter((id) => id !== accountId)
        : [...current, accountId],
    );
  };

  const confirmDelete = async () => {
    const target = deleteConfirm;
    if (!target?.accountId) return;

    setDeleteConfirm(null);
    await withLoading(
      `delete-${target.accountId}`,
      () => api.deleteAccount(target.accountId!),
      tr('已删除'),
    );
  };

  const extractPlatformUserId = (account: any): string => {
    const parsed = parseAccountExtraConfig(account);
    const raw = parsed?.platformUserId;
    const value = Number.parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(value) && value > 0) return String(value);
    const guessed = Number.parseInt(
      String(account?.username || '').match(/(\d{3,8})$/)?.[1] || '',
      10,
    );
    return Number.isFinite(guessed) && guessed > 0 ? String(guessed) : '';
  };

  const openRebindPanel = (account: any) => {
    closeAddPanel();
    setEditingAccount(null);
    setRebindTarget(account);
    setRebindForm(createRebindForm(extractPlatformUserId(account)));
    setRebindVerifyResult(null);
  };

  const closeRebindPanel = () => {
    setRebindTarget(null);
    setRebindForm(createRebindForm());
    setRebindVerifyResult(null);
    setRebindVerifying(false);
    setRebindSaving(false);
  };

  const handleVerifyRebindToken = async () => {
    if (!rebindTarget || !rebindForm.accessToken.trim()) return;
    setRebindVerifying(true);
    setRebindVerifyResult(null);
    try {
      const result = await api.verifyToken({
        siteId: rebindTarget.siteId,
        accessToken: rebindForm.accessToken.trim(),
        platformUserId: rebindForm.platformUserId
          ? Number.parseInt(rebindForm.platformUserId, 10)
          : undefined,
        credentialMode: 'session',
      });
      setRebindVerifyResult(result);
      if (result.success && result.tokenType === 'session') {
        toast.success(tr('Session Token 验证成功，可以重新绑定'));
      } else if (result.success && result.tokenType !== 'session') {
        toast.error(tr('当前是 API Key，不是 Session Token'));
      } else {
        toast.error(
          normalizeVerifyFailureMessage(result.message || tr('Token 无效')),
        );
      }
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(normalizeVerifyFailureMessage(eMessage));
      setRebindVerifyResult({ success: false, message: eMessage });
    } finally {
      setRebindVerifying(false);
    }
  };

  const handleSubmitRebind = async () => {
    if (!rebindTarget || !rebindForm.accessToken.trim()) return;
    if (
      !(
        rebindVerifyResult?.success &&
        rebindVerifyResult?.tokenType === 'session'
      )
    ) {
      toast.error(tr('请先验证新的 Session Token 成功'));
      return;
    }
    const isSub2ApiRebindTarget =
      (rebindTarget?.site?.platform || '').toLowerCase() === 'sub2api';
    setRebindSaving(true);
    try {
      await api.rebindAccountSession(rebindTarget.id, {
        accessToken: rebindForm.accessToken.trim(),
        platformUserId: rebindForm.platformUserId
          ? Number.parseInt(rebindForm.platformUserId, 10)
          : undefined,
        refreshToken:
          isSub2ApiRebindTarget && rebindForm.refreshToken.trim()
            ? rebindForm.refreshToken.trim()
            : undefined,
        tokenExpiresAt:
          isSub2ApiRebindTarget && rebindForm.tokenExpiresAt.trim()
            ? Number.parseInt(rebindForm.tokenExpiresAt, 10)
            : undefined,
      });
      toast.success(tr('账号重新绑定成功，状态已恢复'));
      closeRebindPanel();
      load(true);
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('重新绑定失败'));
    } finally {
      setRebindSaving(false);
    }
  };

  useEffect(() => {
    const { accountId, openRebind } = readFocusAccountIntent(location.search);
    if (!accountId || !loaded || activeSegment === 'tokens') return;

    const cleanedSearch = clearFocusParams(location.search);
    const targetIndex = visibleAccounts.findIndex((account) => account.id === accountId);
    if (targetIndex < 0) {
      navigate(
        { pathname: location.pathname, search: cleanedSearch },
        { replace: true, state: location.state },
      );
      return;
    }
    const targetPage = pageForItemIndex(targetIndex, pageSize);
    if (targetPage !== safePage) {
      setPage(targetPage);
      return;
    }

    const target = visibleAccounts[targetIndex];
    const row = rowRefs.current.get(accountId);
    if (!target || !row) return;

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightAccountId(accountId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightAccountId((current) =>
        current === accountId ? null : current,
      );
    }, 2200);

    if (
      openRebind &&
      target.status === 'expired' &&
      !resolveAccountCapabilities(target).proxyOnly
    ) {
      setShowAdd(false);
      if (!rebindTarget || rebindTarget.id !== target.id) {
        openRebindPanel(target);
      }
    }

    navigate(
      { pathname: location.pathname, search: cleanedSearch },
      { replace: true, state: location.state },
    );
  }, [
    activeSegment,
    loaded,
    location.pathname,
    location.search,
    navigate,
    openRebindPanel,
    pageSize,
    rebindTarget,
    safePage,
    visibleAccounts,
  ]);

  const canAddVerifiedConnection = Boolean(
    verifyResult?.success &&
    ((activeSegment === 'apikey' && verifyResult.tokenType === 'apikey') ||
      (activeSegment === 'session' && verifyResult.tokenType === 'session')),
  );
  const canSubmitApiKeyConnection =
    activeSegment === 'apikey'
      ? isBatchApiKeyInput ||
        canAddVerifiedConnection ||
        !!tokenForm.skipModelFetch
      : canAddVerifiedConnection;

  return (
    <div className={filterSiteId ? '' : 'animate-fade-in'}>
      <div className="page-header">
        {!filterSiteId && (
          <h2 className="page-title">{tr('连接管理')}</h2>
        )}
        {activeSegment !== 'tokens' && (
          <div className="page-actions accounts-page-actions">
            {isMobile ? (
              <>
                {!filterSiteId && (
                  <button
                    type="button"
                    onClick={() => setShowMobileTools(true)}
                    className="btn btn-ghost btn-outline"
                  >{tr('排序与操作')}</button>
                )}
              </>
            ) : (
              <>
                {!filterSiteId && (
                  <div
                    className="accounts-sort-select"
                    style={{ minWidth: 156, position: 'relative', zIndex: 20 }}
                  >
                    <ModernSelect
                      size="sm"
                      value={sortMode}
                      onChange={(nextValue) => setSortMode(nextValue as SortMode)}
                      options={[
                        { value: 'custom', label: tr('默认排序') },
                        { value: 'balance-desc', label: tr('余额高到低') },
                        { value: 'balance-asc', label: tr('余额低到高') },
                      ]}
                      placeholder={tr('默认排序')}
                    />
                  </div>
                )}
                {!filterSiteId && activeSegment === 'session' && (
                  <button
                    onClick={() =>
                      withLoading(
                        'checkin-all',
                        () => api.triggerCheckinAll(),
                        tr('已触发全部签到'),
                      )
                    }
                    disabled={actionLoading['checkin-all']}
                    className="btn btn-soft-primary"
                  >
                    {actionLoading['checkin-all'] ? (
                      <>
                        <span className="spinner spinner-sm" />
                        {tr('签到中...')}
                      </>
                    ) : (
                      tr('全部签到')
                    )}
                  </button>
                )}
                {!filterSiteId && (
                  <button
                    onClick={handleRefreshRuntimeHealth}
                    disabled={actionLoading['health-refresh']}
                    className="btn btn-soft-primary"
                  >
                    {actionLoading['health-refresh'] ? (
                      <>
                        <span className="spinner spinner-sm" />
                        {tr('刷新状态中...')}
                      </>
                    ) : (
                      tr('刷新账户状态')
                    )}
                  </button>
                )}
              </>
            )}
            <button
              onClick={() => {
                const nextOpen = !showAdd;
                if (!nextOpen) {
                  closeAddPanel();
                  return;
                }
                setEditingAccount(null);
                closeRebindPanel();
                setShowAdd(true);
                resetAddForms(activeAddCredentialMode);
                void load(true);
              }}
              className="btn btn-primary"
            >
              {showAdd ? tr('取消') : tr('+ 添加连接')}
            </button>
          </div>
        )}
        {activeSegment === 'tokens' && embeddedTokenActions}
      </div>

      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={showMobileTools}
        onMobileClose={() => setShowMobileTools(false)}
        mobileTitle={tr('连接排序与操作')}
        mobileContent={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                {tr('排序方式')}
              </div>
              <ModernSelect
                value={sortMode}
                onChange={(nextValue) => setSortMode(nextValue as SortMode)}
                options={[
                  { value: 'custom', label: tr('自定义排序') },
                  { value: 'balance-desc', label: tr('余额高到低') },
                  { value: 'balance-asc', label: tr('余额低到高') },
                ]}
                placeholder={tr('自定义排序')}
              />
            </div>
            {activeSegment === 'session' && (
              <button
                onClick={async () => {
                  setShowMobileTools(false);
                  await withLoading(
                    'checkin-all',
                    () => api.triggerCheckinAll(),
                    tr('已触发全部签到'),
                  );
                }}
                disabled={actionLoading['checkin-all']}
                className="btn btn-ghost btn-outline"
              >
                {actionLoading['checkin-all'] ? (
                  <>
                    <span className="spinner spinner-sm" />
                    {tr('签到中...')}
                  </>
                ) : (
                  tr('全部签到')
                )}
              </button>
            )}
            <button
              onClick={async () => {
                setShowMobileTools(false);
                await handleRefreshRuntimeHealth();
              }}
              disabled={actionLoading['health-refresh']}
              className="btn btn-ghost btn-outline"
            >
              {actionLoading['health-refresh'] ? (
                <>
                  <span className="spinner spinner-sm" />
                  {tr('刷新状态中...')}
                </>
              ) : (
                tr('刷新账户状态')
              )}
            </button>
          </div>
        }
      />

      <div
        style={{
          display: 'inline-flex',
          gap: 4,
          padding: 4,
          marginBottom: 16,
          background: 'var(--color-bg-card)',
          border: '1px solid var(--color-border-light)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        {ACCOUNT_SEGMENTS.map((segment) => (
          <button
            key={segment.value}
            type="button"
            onClick={() => setSegment(segment.value)}
            data-tooltip={segment.tooltip}
            data-tooltip-side={segment.tooltipSide}
            data-tooltip-align={segment.tooltipAlign}
            style={{
              padding: '8px 12px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              background:
                activeSegment === segment.value
                  ? 'var(--color-bg)'
                  : 'transparent',
              color:
                activeSegment === segment.value
                  ? 'var(--color-primary)'
                  : 'var(--color-text-secondary)',
              boxShadow:
                activeSegment === segment.value ? 'var(--shadow-sm)' : 'none',
              transition: 'all 0.2s ease',
            }}
          >
            {segment.label}
          </button>
        ))}
      </div>

      <DeleteConfirmModal
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={confirmDelete}
        title={tr('确认删除连接')}
        confirmText={tr('确认删除')}
        loading={Boolean(
          deleteConfirm?.accountId &&
            actionLoading[`delete-${deleteConfirm.accountId}`],
        )}
        description={
          <>
            确定要删除连接{' '}
            <strong>
              {deleteConfirm?.accountName || `#${deleteConfirm?.accountId}`}
            </strong>{' '}
            {tr('吗？')}
          </>
        }
      />

      {activeSegment === 'tokens' ? (
        <TokensPanel
          embedded
          onEmbeddedActionsChange={setEmbeddedTokenActions}
          siteId={filterSiteId}
        />
      ) : (
        <>
          <CenteredModal
            open={showAdd}
            onClose={closeAddPanel}
            title={
              activeSegment === 'apikey'
                ? tr('添加 API Key 连接')
                : addMode === 'login'
                  ? tr('账号密码登录')
                  : tr('添加 Session 连接')
            }
            maxWidth={860}
            bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            footer={
              <button onClick={closeAddPanel} className="btn btn-ghost">
                {tr('取消')}
              </button>
            }
          >
            {activeSegment === 'session' ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    gap: 0,
                    background: 'var(--color-bg-inset)',
                    borderRadius: 'var(--radius-sm)',
                    padding: 3,
                    marginBottom: 16,
                  }}
                >
                  <button
                    onClick={() => {
                      setAddMode('token');
                      setVerifyResult(null);
                    }}
                    style={{
                      flex: 1,
                      padding: '8px 0',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 13,
                      fontWeight: 500,
                      border: 'none',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      background:
                        addMode === 'token'
                          ? 'var(--color-bg-card)'
                          : 'transparent',
                      color:
                        addMode === 'token'
                          ? 'var(--color-primary)'
                          : 'var(--color-text-muted)',
                      boxShadow:
                        addMode === 'token' ? 'var(--shadow-sm)' : 'none',
                    }}
                  >
                    Session Token / Cookie
                  </button>
                  {!isSub2ApiSelected && selectedSiteSupportsLogin && (
                    <button
                      onClick={() => {
                        setAddMode('login');
                        setVerifyResult(null);
                      }}
                      style={{
                        flex: 1,
                        padding: '8px 0',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 13,
                        fontWeight: 500,
                        border: 'none',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        background:
                          addMode === 'login'
                            ? 'var(--color-bg-card)'
                            : 'transparent',
                        color:
                          addMode === 'login'
                            ? 'var(--color-primary)'
                            : 'var(--color-text-muted)',
                        boxShadow:
                          addMode === 'login' ? 'var(--shadow-sm)' : 'none',
                      }}
                    >{tr('账号密码登录')}</button>
                  )}
                </div>

                {addMode === 'token' ? (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    <div className="info-tip">
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>{tr('当前分段仅创建 Session 连接')}</div>
                        <div>
                          <strong>{tr('推荐')}</strong> {tr('使用系统访问令牌（Access Token）；浏览器 Cookie 仅用于兼容场景。')}</div>
                        <div style={{ marginTop: 2 }}>{tr('以 NewAPI 为例：控制台 → 个人设置 → 安全设置 → 生成「系统访问令牌」')}</div>
                        <div
                          style={{
                            opacity: 0.7,
                            borderTop: '1px solid rgba(0,0,0,0.1)',
                            paddingTop: 6,
                            marginTop: 6,
                          }}
                        >
                          获取 Cookie:{' '}
                          <kbd
                            style={{
                              padding: '1px 5px',
                              background: 'var(--color-bg-card)',
                              border: '1px solid var(--color-border)',
                              borderRadius: 6,
                              fontSize: 11,
                            }}
                          >
                            F12
                          </kbd>{' '}
                          → Application → Cookie
                        </div>
                        <div style={{ marginTop: 6 }}>
                          <a
                            href={SITE_DOCS_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: 12,
                              color: 'var(--color-primary)',
                              textDecoration: 'underline',
                            }}
                          >{tr('查看认证方式与特殊站点说明文档')}</a>
                        </div>
                      </div>
                    </div>
                    <div
                      style={{
                        padding: '9px 12px',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--color-bg-inset)',
                        color: 'var(--color-text)',
                        fontSize: 13,
                      }}
                    >
                      {selectedTokenSite
                        ? `${selectedTokenSite.name} (${selectedTokenSite.platform})`
                        : tr('当前站点')}
                    </div>
                    <input
                      placeholder={tr('连接名称（可选）')}
                      value={tokenForm.username}
                      onChange={(e) =>
                        setTokenForm((f) => ({
                          ...f,
                          username: e.target.value,
                        }))
                      }
                      style={inputStyle}
                    />
                    <textarea
                      placeholder={tr('粘贴 Session Access Token 或浏览器 Cookie')}
                      value={tokenForm.accessToken}
                      onChange={(e) => {
                        setTokenForm((f) => ({
                          ...f,
                          accessToken: e.target.value.trim(),
                        }));
                        setVerifyResult(null);
                      }}
                      style={{
                        ...inputStyle,
                        fontFamily: 'var(--font-mono)',
                        height: 72,
                        resize: 'none' as const,
                      }}
                    />
                    {platformRequiresUserId(selectedTokenSite?.platform) && (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                        }}
                      >
                        <input
                          placeholder={tr('用户 ID（可选）')}
                          value={tokenForm.platformUserId}
                          onChange={(e) => {
                            setTokenForm((f) => ({
                              ...f,
                              platformUserId: e.target.value.replace(/\D/g, ''),
                            }));
                            setVerifyResult(null);
                          }}
                          style={inputStyle}
                        />
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--color-text-muted)',
                          }}
                        >{tr('若站点要求 New-Api-User / User-ID，请在这里提前填写。')}</div>
                      </div>
                    )}
                    {isSub2ApiSelected && (
                      <>
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                          }}
                        >
                          <input
                            placeholder={tr('Sub2API refresh_token（可选，用于托管自动续期）')}
                            value={tokenForm.refreshToken}
                            onChange={(e) =>
                              setTokenForm((f) => ({
                                ...f,
                                refreshToken: e.target.value.trim(),
                              }))
                            }
                            style={{
                              ...inputStyle,
                              fontFamily: 'var(--font-mono)',
                            }}
                          />
                          <div
                            style={{
                              fontSize: 12,
                              color: 'var(--color-text-muted)',
                            }}
                          >
                            可在浏览器控制台执行{' '}
                            <code style={{ fontFamily: 'var(--font-mono)' }}>
                              localStorage.getItem('refresh_token')
                            </code>{' '}
                            {tr('获取。')}
                          </div>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                          }}
                        >
                          <input
                            placeholder={tr('token_expires_at（可选，毫秒时间戳）')}
                            value={tokenForm.tokenExpiresAt}
                            onChange={(e) =>
                              setTokenForm((f) => ({
                                ...f,
                                tokenExpiresAt: e.target.value.replace(
                                  /\D/g,
                                  '',
                                ),
                              }))
                            }
                            style={inputStyle}
                          />
                          <div
                            style={{
                              fontSize: 12,
                              color: 'var(--color-text-muted)',
                            }}
                          >{tr('配置 refresh_token 后，metapi 会在 JWT 临近过期或 401 时自动续期并回写新 token。')}</div>
                        </div>
                      </>
                    )}
                    {verifyResult &&
                      verifyResult.success &&
                      verifyResult.tokenType === 'session' && (
                        <div className="alert alert-success animate-scale-in">
                          <div
                            className="alert-title"
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
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
                                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                              />
                            </svg>{tr('Session 凭证有效（Access Token / Cookie）')}</div>
                          <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                            <div>
                              用户名:{' '}
                              <strong>
                                {verifyResult.userInfo?.username || tr('未知')}
                              </strong>
                            </div>
                            {verifyResult.balance && (
                              <div>
                                余额:{' '}
                                <strong>
                                  $
                                  {(verifyResult.balance.balance || 0).toFixed(
                                    2,
                                  )}
                                </strong>
                              </div>
                            )}
                            <div>
                              API Key:{' '}
                              <span
                                style={{
                                  fontWeight: 500,
                                  color: verifyResult.apiToken
                                    ? 'var(--color-success)'
                                    : 'var(--color-text-muted)',
                                }}
                              >
                                {verifyResult.apiToken
                                  ? `已找到 (${verifyResult.apiToken.substring(0, 8)}...)`
                                  : tr('未找到')}
                              </span>
                            </div>
                          </div>
                        </div>
                      )}
                    {verifyResult &&
                      verifyResult.success &&
                      verifyResult.tokenType === 'apikey' && (
                        <div className="alert alert-warning animate-scale-in">
                          <div className="alert-title">{tr('当前分段仅接受 Session 凭证，请切到「API Key 连接」分段创建。')}</div>
                        </div>
                      )}
                    {verifyResult &&
                      !verifyResult.success &&
                      verifyResult.needsUserId && (
                        <div className="alert alert-warning animate-scale-in">
                          <div className="alert-title">{tr('此站点要求用户 ID，请补充后重新验证')}</div>
                        </div>
                      )}
                    {verifyResult &&
                      !verifyResult.success &&
                      !verifyResult.needsUserId && (
                        <div className="alert alert-error animate-scale-in">
                          <div className="alert-title">
                            {normalizeVerifyFailureMessage(
                              verifyResult.message,
                            ) || tr('Token 无效或已过期')}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: 'var(--color-text-muted)',
                              marginTop: 4,
                            }}
                          >
                            {verifyFailureHint || tr('请检查 Token 是否正确')}
                          </div>
                        </div>
                      )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={handleVerifyToken}
                        disabled={
                          verifying ||
                          !tokenForm.siteId ||
                          !tokenForm.accessToken
                        }
                        className="btn btn-ghost"
                        style={{
                          border: '1px solid var(--color-border)',
                          padding: '8px 14px',
                        }}
                      >
                        {verifying ? (
                          <>
                            <span className="spinner spinner-sm" />{tr('验证中...')}</>
                        ) : (
                          tr('验证 Token')
                        )}
                      </button>
                      <button
                        onClick={handleTokenAdd}
                        disabled={
                          saving ||
                          !tokenForm.siteId ||
                          !tokenForm.accessToken ||
                          !canAddVerifiedConnection
                        }
                        className="btn btn-primary"
                      >
                        {saving ? (
                          <>
                            <span
                              className="spinner spinner-sm"
                              style={{
                                borderTopColor: 'white',
                                borderColor: 'rgba(255,255,255,0.3)',
                              }}
                            />{tr('添加中...')}</>
                        ) : (
                          tr('添加连接')
                        )}
                      </button>
                    </div>
                    {!verifyResult?.success && (
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--color-text-muted)',
                        }}
                      >
                        {addAccountPrereqHint}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    <div className="info-tip">{tr('输入目标站点的账号密码，将自动登录并获取访问令牌和 API Key')}</div>
                    <div
                      style={{
                        padding: '9px 12px',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--color-bg-inset)',
                        color: 'var(--color-text)',
                        fontSize: 13,
                      }}
                    >
                      {selectedTokenSite
                        ? `${selectedTokenSite.name} (${selectedTokenSite.platform})`
                        : tr('当前站点')}
                    </div>
                    <input
                      placeholder={tr('用户名')}
                      value={loginForm.username}
                      onChange={(e) =>
                        setLoginForm((f) => ({
                          ...f,
                          username: e.target.value,
                        }))
                      }
                      style={inputStyle}
                    />
                    <input
                      type="password"
                      placeholder={tr('密码')}
                      value={loginForm.password}
                      onChange={(e) =>
                        setLoginForm((f) => ({
                          ...f,
                          password: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => e.key === 'Enter' && handleLoginAdd()}
                      style={inputStyle}
                    />
                    <button
                      onClick={handleLoginAdd}
                      disabled={
                        saving ||
                        !loginForm.siteId ||
                        !loginForm.username ||
                        !loginForm.password
                      }
                      className="btn btn-primary"
                      style={{ alignSelf: 'flex-start' }}
                    >
                      {saving ? (
                        <>
                          <span
                            className="spinner spinner-sm"
                            style={{
                              borderTopColor: 'white',
                              borderColor: 'rgba(255,255,255,0.3)',
                            }}
                          />{tr('登录并添加...')}</>
                      ) : (
                        tr('登录并添加')
                      )}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
              >
                <div className="info-tip">{tr('API Key 连接只用于代理转发，不会自动派生账号令牌。系统会按站点平台能力自动引导到 Session 或 API Key 创建流程。')}</div>
                {createIntentPreset && (
                  <div className="alert alert-info animate-scale-in">
                    <div className="alert-title">
                      {createIntentPreset.label}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--color-text-muted)',
                        marginTop: 4,
                        lineHeight: 1.8,
                      }}
                    >
                      <div>{createIntentPreset.description}</div>
                      <div>
                        {tr('推荐模型：')}
                        {createIntentPreset.recommendedModels.join(' / ')}
                      </div>
                      {createIntentPreset.recommendedSkipModelFetch && (
                        <div>{tr('建议直接跳过模型验证，先保存 Base URL + Key，再补入推荐模型完成初始化。')}</div>
                      )}
                    </div>
                    {createIntentPreset.recommendedModels.length > 0 && (
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12,
                          cursor: 'pointer',
                          marginTop: 8,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={applyCreatePresetModels}
                          onChange={(e) =>
                            setApplyCreatePresetModels(e.target.checked)
                          }
                          style={{ width: 14, height: 14 }}
                        />
                        <span>{tr('添加后自动补入推荐模型并重建路由')}</span>
                      </label>
                    )}
                  </div>
                )}
                <ModernSelect
                  value={String(tokenForm.siteId || 0)}
                  onChange={(nextValue) => {
                    const nextSiteId = Number.parseInt(nextValue, 10) || 0;
                    setTokenForm((f) => ({
                      ...f,
                      siteId: nextSiteId,
                      credentialMode: 'apikey',
                    }));
                    setLoginForm((f) => ({ ...f, siteId: nextSiteId }));
                    const nextPlatform = sites.find((s) => s.id === nextSiteId)?.platform?.toLowerCase() || '';
                    if (nextPlatform === 'sub2api') {
                      setAddMode('token');
                    }
                    setVerifyResult(null);
                    if (
                      createIntentPresetId &&
                      nextSiteId !== tokenForm.siteId
                    ) {
                      setCreateIntentPresetId(null);
                      setApplyCreatePresetModels(false);
                    }
                  }}
                  options={siteSelectOptions}
                  placeholder={tr('选择站点')}
                  searchable
                  searchPlaceholder={SITE_SELECT_SEARCH_PLACEHOLDER}
                />
                <input
                  placeholder={tr('连接名称（可选）')}
                  value={tokenForm.username}
                  onChange={(e) =>
                    setTokenForm((f) => ({
                      ...f,
                      username: e.target.value,
                      credentialMode: 'apikey',
                    }))
                  }
                  style={inputStyle}
                />
                <textarea
                  placeholder={tr('粘贴 API Key（无需认证时可留空）')}
                  value={tokenForm.accessToken}
                  onChange={(e) => {
                    setTokenForm((f) => ({
                      ...f,
                      accessToken: e.target.value,
                      credentialMode: 'apikey',
                    }));
                    setVerifyResult(null);
                  }}
                  style={{
                    ...inputStyle,
                    fontFamily: 'var(--font-mono)',
                    height: 72,
                    resize: 'none' as const,
                  }}
                />
                {parsedApiKeys.length > 0 && (
                  <div
                    style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                  >
                    {tr('已识别')} {parsedApiKeys.length} {tr('个 API Key')}
                    {isBatchApiKeyInput
                      ? tr('，添加时会逐条创建同站点连接并参与轮询')
                      : ''}
                  </div>
                )}
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('支持换行、空格、逗号批量粘贴多个 API Key。')}</div>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                    cursor: 'pointer',
                    alignSelf: 'flex-start',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!tokenForm.skipModelFetch}
                    onChange={(e) =>
                      setTokenForm((f) => ({
                        ...f,
                        skipModelFetch: e.target.checked,
                      }))
                    }
                    style={{ width: 14, height: 14 }}
                  />
                  <span>{tr('跳过模型验证（直接添加 API Key）')}</span>
                </label>
                {verifyResult &&
                  verifyResult.success &&
                  verifyResult.tokenType === 'apikey' && (
                    <div className="alert alert-info animate-scale-in">
                      <div
                        className="alert-title"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
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
                            d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                          />
                        </svg>{tr('API Key 验证成功')}</div>
                      <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                        <div>
                          可用模型:{' '}
                          <strong>{verifyResult.modelCount} 个</strong>
                        </div>
                        {verifyResult.models && (
                          <div style={{ color: 'var(--color-text-muted)' }}>
                            包含: {verifyResult.models.join(', ')}
                            {verifyResult.modelCount > 10 ? ' ...' : ''}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                {verifyResult &&
                  verifyResult.success &&
                  verifyResult.tokenType === 'session' && (
                    <div className="alert alert-warning animate-scale-in">
                      <div className="alert-title">{tr('当前分段仅接受 API Key，请切到「Session 连接」分段创建。')}</div>
                    </div>
                  )}
                {verifyResult &&
                  !verifyResult.success &&
                  verifyResult.needsUserId && (
                    <div className="alert alert-warning animate-scale-in">
                      <div className="alert-title">{tr('此站点要求用户 ID，请补充后重新验证')}</div>
                    </div>
                  )}
                {verifyResult &&
                  !verifyResult.success &&
                  !verifyResult.needsUserId && (
                    <div className="alert alert-error animate-scale-in">
                      <div className="alert-title">
                        {normalizeVerifyFailureMessage(verifyResult.message) ||
                          tr('Token 无效或已过期')}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--color-text-muted)',
                          marginTop: 4,
                        }}
                      >
                        {verifyFailureHint || tr('请检查 Token 是否正确')}
                      </div>
                    </div>
                  )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={handleVerifyToken}
                    disabled={
                      verifying ||
                      !tokenForm.siteId ||
                      isBatchApiKeyInput
                    }
                    className="btn btn-ghost"
                    style={{
                      border: '1px solid var(--color-border)',
                      padding: '8px 14px',
                    }}
                  >
                    {verifying ? (
                      <>
                        <span className="spinner spinner-sm" />{tr('验证中...')}</>
                    ) : isBatchApiKeyInput ? (
                      tr('批量添加时校验')
                    ) : (
                      tr('验证 API Key')
                    )}
                  </button>
                  <button
                    onClick={handleTokenAdd}
                    disabled={
                      saving ||
                      !tokenForm.siteId ||
                      !canSubmitApiKeyConnection
                    }
                    className="btn btn-primary"
                  >
                    {saving ? (
                      <>
                        <span
                          className="spinner spinner-sm"
                          style={{
                            borderTopColor: 'white',
                            borderColor: 'rgba(255,255,255,0.3)',
                          }}
                        />{tr('添加中...')}</>
                    ) : isBatchApiKeyInput ? (
                      tr('批量添加连接')
                    ) : (
                      tr('添加连接')
                    )}
                  </button>
                </div>
                {!verifyResult?.success && (
                  <div
                    style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                  >
                    {isBatchApiKeyInput
                      ? tr('批量模式下无需先点验证，提交后会逐条校验并创建。')
                      : addAccountPrereqHint}
                  </div>
                )}
              </div>
            )}
          </CenteredModal>

          {activeSegment === 'session' && (
            <AccountRebindModal
              open={Boolean(rebindTarget)}
              accountLabel={activeRebindTarget ? resolveAccountDisplayName(activeRebindTarget) : ''}
              siteName={activeRebindTarget?.site?.name || '-'}
              form={rebindForm}
              verifyResult={rebindVerifyResult}
              verifying={rebindVerifying}
              saving={rebindSaving}
              showUserId={platformRequiresUserId(activeRebindTarget?.site?.platform)}
              showSub2Api={isRebindSub2Api}
              inputStyle={inputStyle}
              onClose={closeRebindPanel}
              onFormChange={setRebindForm}
              onClearVerification={() => setRebindVerifyResult(null)}
              onVerify={handleVerifyRebindToken}
              onSubmit={handleSubmitRebind}
            />
          )}

          <EditAccountModal
            open={Boolean(editingAccount)}
            account={editingAccount}
            onClose={closeEditPanel}
            onSaved={() => load(true)}
          />

          <div className="card" style={{ paddingBottom: 12 }}>
            {visibleAccounts.length > 0 ? (
              isMobile ? (
                <div className="mobile-card-list" ref={accountsMobileListRef}>
                  <DndContext
                    sensors={accountSortSensors}
                    collisionDetection={closestCenter}
                    onDragStart={handleAccountDragStart}
                    onDragOver={handleAccountDragOver}
                    onDragCancel={clearAccountDragState}
                    onDragEnd={handleAccountDragEnd}
                  >
                  <SortableContext items={sortableContextItems} strategy={verticalListSortingStrategy}>
                  {pagedAccounts.map((a: any) => {
                    const capabilities = resolveAccountCapabilities(a);
                    const health = resolveRuntimeHealth(a);
                    const isExpanded = expandedAccountIds.includes(a.id);
                    const hintMessage =
                      a.status === 'expired' && !capabilities.proxyOnly
                        ? tr('账号已过期，请重新绑定')
                        : health.reason || '-';
                    return (
                      <SortableAccountMobileCard
                        key={a.id}
                        id={a.id}
                        label={resolveAccountDisplayName(a)}
                        disabled={sortMode !== 'custom'}
                        isDropTarget={overDragAccountId === a.id && activeDragAccountId !== a.id}
                      >
                      <MobileCard
                        title={resolveAccountDisplayName(a)}
                        footerActions={
                          <>
                            <button
                              type="button"
                              onClick={() => toggleAccountDetails(a.id)}
                              className="btn btn-link"
                            >
                              {isExpanded ? tr('收起') : tr('详情')}
                            </button>
                            <button
                              onClick={() => openEditPanel(a)}
                              className="btn btn-link btn-link-info"
                            >{tr('编辑')}</button>
                            <button
                              onClick={() => openModelModal(a)}
                              disabled={actionLoading[`models-${a.id}`]}
                              className="btn btn-link btn-link-info"
                            >{tr('模型')}</button>
                          </>
                        }
                      >
                        <MobileField
                          label={tr('运行健康状态')}
                          value={
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 4,
                              }}
                            >
                              <StatusText badgeClass={health.cls} style={{ fontSize: 11 }}>
                                {health.label}
                              </StatusText>
                              <span
                                style={{
                                  fontSize: 11,
                                  color: 'var(--color-text-muted)',
                                  maxWidth: 240,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                                data-tooltip={health.reason}
                              >
                                {health.reason}
                              </span>
                            </div>
                          }
                        />
                        <MobileField
                          label={tr('余额')}
                          value={
                            <div
                              style={{
                                display: 'flex',
                                flexWrap: 'nowrap',
                                alignItems: 'baseline',
                                gap: 4,
                                justifyContent: 'flex-end',
                              }}
                            >
                              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
                                ${(a.balance || 0).toFixed(2)}
                              </span>
                              {(a.todayReward || 0) > 0 && (
                                <span className="site-balance-reward">
                                  +{(a.todayReward || 0).toFixed(2)}
                                </span>
                              )}
                              {(a.todaySpend || 0) > 0 && (
                                <span className="site-balance-spend">
                                  -{(a.todaySpend || 0).toFixed(2)}
                                </span>
                              )}
                            </div>
                          }
                        />
                        {isExpanded ? (
                          <div className="mobile-card-extra">
                            <MobileField
                              label={tr('站点')}
                              value={
                                <SiteBadgeLink
                                  siteId={a.site?.id}
                                  siteName={a.site?.name}
                                  siteUrl={a.site?.url}
                                  badgeStyle={{ fontSize: 11 }}
                                />
                              }
                            />
                            <MobileField
                              label={tr('签到')}
                              value={
                                capabilities.canCheckin ? (
                                  <StatusToggle
                                    enabled={a.checkinEnabled}
                                    onLabel={tr('开启')}
                                    offLabel={tr('关闭')}
                                    onClick={() => handleToggleCheckin(a)}
                                    busy={!!actionLoading[`checkin-toggle-${a.id}`]}
                                    tooltipOn={tr('点击关闭签到，全部签到会忽略此账号')}
                                    tooltipOff={tr('点击开启签到')}
                                  />
                                ) : (
                                  <StatusPill tone="muted" style={{ fontSize: 11 }}>{tr('不支持')}</StatusPill>
                                )
                              }
                            />
                            <MobileField
                              label={tr('账号状态')}
                              value={
                                a.status === 'expired'
                                  ? tr('已过期')
                                  : a.status || '-'
                              }
                            />
                            {(() => {
                              const sub2ApiUsage = parseSub2ApiAccountUsage(a);
                              const sub2ApiLabel = formatSub2ApiUsageInline(sub2ApiUsage);
                              if (sub2ApiLabel) {
                                return (
                                  <MobileField
                                    label={tr('订阅用量')}
                                    value={sub2ApiLabel}
                                  />
                                );
                              }
                              return null;
                            })()}
                            <MobileField
                              label={tr('提示')}
                              stacked
                              value={hintMessage}
                            />
                            <div className="mobile-card-actions">
                              <button
                                onClick={() => handleTogglePin(a)}
                                disabled={!!actionLoading[`pin-toggle-${a.id}`]}
                                className={`btn btn-link ${a.isPinned ? 'btn-link-warning' : 'btn-link-primary'}`}
                              >
                                {actionLoading[`pin-toggle-${a.id}`] ? (
                                  <span className="spinner spinner-sm" />
                                ) : a.isPinned ? (
                                  tr('取消置顶')
                                ) : (
                                  tr('置顶')
                                )}
                              </button>
                              {capabilities.canRefreshBalance && (
                                <button
                                  onClick={() =>
                                    withLoading(
                                      `refresh-${a.id}`,
                                      () => api.refreshBalance(a.id),
                                      tr('余额已刷新'),
                                    )
                                  }
                                  disabled={actionLoading[`refresh-${a.id}`]}
                                  className="btn btn-link btn-link-primary"
                                >
                                  {actionLoading[`refresh-${a.id}`] ? (
                                    <span className="spinner spinner-sm" />
                                  ) : (
                                    tr('刷新')
                                  )}
                                </button>
                              )}
                              {capabilities.canCheckin && (
                                <button
                                  onClick={() =>
                                    withLoading(
                                      `checkin-${a.id}`,
                                      () => api.triggerCheckin(a.id),
                                      tr('签到完成'),
                                    )
                                  }
                                  disabled={actionLoading[`checkin-${a.id}`]}
                                  className="btn btn-link btn-link-warning"
                                >
                                  {actionLoading[`checkin-${a.id}`] ? (
                                    <span className="spinner spinner-sm" />
                                  ) : (
                                    tr('签到')
                                  )}
                                </button>
                              )}
                              {a.status === 'expired' &&
                                !capabilities.proxyOnly && (
                                  <button
                                    onClick={() => openRebindPanel(a)}
                                    className="btn btn-link btn-link-warning"
                                  >{tr('重新绑定')}</button>
                                )}
                              <button
                                onClick={() =>
                                  setDeleteConfirm({
                                    mode: 'single',
                                    accountId: a.id,
                                    accountName: resolveAccountDisplayName(a),
                                  })
                                }
                                disabled={actionLoading[`delete-${a.id}`]}
                                className="btn btn-link btn-link-danger"
                              >
                                {actionLoading[`delete-${a.id}`] ? (
                                  <span className="spinner spinner-sm" />
                                ) : (
                                  tr('删除')
                                )}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </MobileCard>
                      </SortableAccountMobileCard>
                    );
                  })}
                  </SortableContext>
                  </DndContext>
                </div>
                ) : (
                  <div className="accounts-desktop-table-wrap" ref={accountsTableWrapRef}>
                <DndContext
                  sensors={accountSortSensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleAccountDragStart}
                  onDragOver={handleAccountDragOver}
                  onDragCancel={clearAccountDragState}
                  onDragEnd={handleAccountDragEnd}
                >
                <SortableContext items={sortableContextItems} strategy={verticalListSortingStrategy}>
                <table className="data-table accounts-table">
                  <thead>
                    <tr>
                      <th>{tr('连接名称')}</th>
                      <th>{tr('站点')}</th>
                      <th>{tr('运行健康状态')}</th>
                      <th style={{ textAlign: 'left' }}>{tr('余额')}</th>
                      <th>{tr('签到')}</th>
                      <th className="accounts-actions-col">{tr('操作')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedAccounts.map((a: any, i: number) => {
                      const capabilities = resolveAccountCapabilities(a);
                      return (
                        <SortableAccountTableRow
                          key={a.id}
                          id={a.id}
                          label={resolveAccountDisplayName(a)}
                          disabled={sortMode !== 'custom'}
                          isDropTarget={overDragAccountId === a.id && activeDragAccountId !== a.id}
                          dataTestId={`account-row-${a.id}`}
                          className={`animate-slide-up stagger-${Math.min(i + 1, 5)} ${highlightAccountId === a.id ? 'row-focus-highlight' : ''}`.trim()}
                          rowRef={(node) => {
                            if (node) rowRefs.current.set(a.id, node);
                            else rowRefs.current.delete(a.id);
                          }}
                        >
                          <td className="accounts-name-cell" style={{ color: 'var(--color-text-primary)' }}>
                            <div className="inventory-name-title" style={{ fontWeight: 600 }} title={resolveAccountDisplayName(a)}>
                              {resolveAccountDisplayName(a)}
                            </div>
                          </td>
                          <td className="accounts-site-cell">
                            <SiteBadgeLink
                              siteId={a.site?.id}
                              siteName={a.site?.name}
                              siteUrl={a.site?.url}
                              badgeStyle={{ fontSize: 11 }}
                            />
                          </td>
                          <td>
                            {(() => {
                              const health = resolveRuntimeHealth(a);
                              return (
                                <div
                                  style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 4,
                                  }}
                                >
                                  <StatusText badgeClass={health.cls} style={{ fontSize: 11 }}>
                                    {health.label}
                                  </StatusText>
                                  <span
                                    className="accounts-health-reason"
                                    style={{
                                      fontSize: 11,
                                      color: 'var(--color-text-muted)',
                                    }}
                                    data-tooltip={health.reason}
                                    title={health.reason}
                                  >
                                    {health.reason}
                                  </span>
                                </div>
                              );
                            })()}
                          </td>
                          <td style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            <div
                              style={{
                                display: 'flex',
                                flexWrap: 'nowrap',
                                alignItems: 'baseline',
                                gap: 4,
                              }}
                            >
                              {(() => {
                                // sub2api 账号：显示订阅用量（套餐/已用/总额度/剩余）
                                const sub2ApiUsage = parseSub2ApiAccountUsage(a);
                                const sub2ApiLabel = formatSub2ApiUsageInline(sub2ApiUsage);
                                if (sub2ApiLabel) {
                                  return (
                                    <span
                                      className="site-balance-subscription"
                                      style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}
                                      title={`${sub2ApiLabel}${sub2ApiUsage?.activeCount ? ` · 生效订阅 ${sub2ApiUsage.activeCount} 个` : ''}`}
                                    >
                                      {sub2ApiLabel}
                                    </span>
                                  );
                                }
                                // 普通账号：显示余额
                                return (
                                  <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
                                    ${(a.balance || 0).toFixed(2)}
                                  </span>
                                );
                              })()}
                              {(a.todayReward || 0) > 0 && (
                                <span className="site-balance-reward">
                                  +{(a.todayReward || 0).toFixed(2)}
                                </span>
                              )}
                              {(a.todaySpend || 0) > 0 && (
                                <span className="site-balance-spend">
                                  -{(a.todaySpend || 0).toFixed(2)}
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            {capabilities.canCheckin ? (
                              <StatusToggle
                                enabled={a.checkinEnabled}
                                onLabel={tr('开启')}
                                offLabel={tr('关闭')}
                                onClick={() => handleToggleCheckin(a)}
                                busy={!!actionLoading[`checkin-toggle-${a.id}`]}
                                tooltipOn={tr('点击关闭签到，全部签到会忽略此账号')}
                                tooltipOff={tr('点击开启签到')}
                              />
                            ) : (
                              <StatusPill tone="muted" style={{ fontSize: 11 }}>{tr('不支持')}</StatusPill>
                            )}
                          </td>
                          <td className="accounts-actions-cell">
                            <div className="accounts-row-actions">
                              <button
                                onClick={() => handleTogglePin(a)}
                                disabled={!!actionLoading[`pin-toggle-${a.id}`]}
                                className={`btn btn-link ${a.isPinned ? 'btn-link-warning' : 'btn-link-primary'}`}
                              >
                                {actionLoading[`pin-toggle-${a.id}`] ? (
                                  <span className="spinner spinner-sm" />
                                ) : a.isPinned ? (
                                  tr('取消置顶')
                                ) : (
                                  tr('置顶')
                                )}
                              </button>
                              {capabilities.canRefreshBalance && (
                                <button
                                  onClick={() =>
                                    withLoading(
                                      `refresh-${a.id}`,
                                      () => api.refreshBalance(a.id),
                                      tr('余额已刷新'),
                                    )
                                  }
                                  disabled={actionLoading[`refresh-${a.id}`]}
                                  className="btn btn-link btn-link-primary"
                                >
                                  {actionLoading[`refresh-${a.id}`] ? (
                                    <span className="spinner spinner-sm" />
                                  ) : (
                                    tr('刷新')
                                  )}
                                </button>
                              )}
                              <button
                                onClick={() => openModelModal(a)}
                                disabled={actionLoading[`models-${a.id}`]}
                                className="btn btn-link btn-link-info"
                              >{tr('模型')}</button>
                              {capabilities.canCheckin && (
                                <button
                                  onClick={() =>
                                    withLoading(
                                      `checkin-${a.id}`,
                                      () => api.triggerCheckin(a.id),
                                      tr('签到完成'),
                                    )
                                  }
                                  disabled={actionLoading[`checkin-${a.id}`]}
                                  className="btn btn-link btn-link-warning"
                                >
                                  {actionLoading[`checkin-${a.id}`] ? (
                                    <span className="spinner spinner-sm" />
                                  ) : (
                                    tr('签到')
                                  )}
                                </button>
                              )}
                              {a.status === 'expired' &&
                                !capabilities.proxyOnly && (
                                  <button
                                    onClick={() => openRebindPanel(a)}
                                    className="btn btn-link btn-link-warning"
                                  >{tr('重新绑定')}</button>
                                )}
                              <button
                                onClick={() => openEditPanel(a)}
                                className="btn btn-link btn-link-info"
                              >{tr('编辑')}</button>
                              <button
                                onClick={() =>
                                  setDeleteConfirm({
                                    mode: 'single',
                                    accountId: a.id,
                                    accountName: resolveAccountDisplayName(a),
                                  })
                                }
                                disabled={actionLoading[`delete-${a.id}`]}
                                className="btn btn-link btn-link-danger"
                              >
                                {actionLoading[`delete-${a.id}`] ? (
                                  <span className="spinner spinner-sm" />
                                ) : (
                                  tr('删除')
                                )}
                              </button>
                            </div>
                          </td>
                        </SortableAccountTableRow>
                      );
                    })}
                  </tbody>
                </table>
                </SortableContext>
                </DndContext>
                <PaginationControls
                  page={safePage}
                  totalPages={totalPages}
                  onPageChange={setPage}
                  visible={showAccountPagination}
                  pageSize={exactPageSize}
                  onPageSizeChange={setExactPageSize}
                />
                  </div>
              )
            ) : (
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
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                <div className="empty-state-title">
                  {activeSegment === 'apikey'
                    ? tr('暂无 API Key 连接')
                    : tr('暂无 Session 连接')}
                </div>
                <div className="empty-state-desc">
                  {activeSegment === 'apikey'
                    ? sites.length > 0
                      ? tr('请为现有站点补充 API Key 连接')
                      : tr('请先添加站点，然后为站点补充 API Key 连接')
                    : sites.length > 0
                      ? tr('请为现有站点添加 Session 连接')
                      : tr('请先添加站点，然后添加 Session 连接')}
                </div>
              </div>
            )}
            {isMobile ? (
              <PaginationControls
                page={safePage}
                totalPages={totalPages}
                onPageChange={setPage}
                visible={showAccountPagination}
                pageSize={exactPageSize}
                onPageSizeChange={setExactPageSize}
              />
            ) : null}
          </div>
        </>
      )}

      <AccountModelsModal
        modelModal={modelModal}
        inputStyle={inputStyle}
        onClose={closeModelModal}
        onSave={saveModelDisabled}
        onRefresh={async () => {
          if (!modelModal.account) return;
          await loadModelModalModels(modelModal.account, {
            refreshUpstream: true,
            successMessage: tr('模型列表已刷新'),
            errorMessage: tr('刷新失败'),
          });
        }}
        onToggleModelDisabled={toggleModelDisabled}
        onNewModelPolicyChange={(policy) =>
          setModelModal((state) => ({ ...state, newModelPolicy: policy }))
        }
        onSetPendingDisabled={(pendingDisabled) =>
          setModelModal((state) => ({ ...state, pendingDisabled }))
        }
        onManualInputChange={(value) =>
          setModelModal((state) => ({ ...state, manualModelsInput: value }))
        }
        onAddManualModels={handleAddManualModels}
        onRemoveManualModel={handleRemoveManualModel}
        removingManualModelName={modelModal.removingManualModelName ?? null}
      />
    </div>
  );
}
