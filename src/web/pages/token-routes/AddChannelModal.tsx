import { useState, useMemo } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import ModernSelect from '../../components/ModernSelect.js';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { tr } from '../../i18n.js';
import type { RouteCandidateView, RouteAccountOption, RouteTokenOption } from '../helpers/routeModelCandidatesIndex.js';
import type { RouteMissingTokenHint } from '../helpers/routeMissingTokenHints.js';
import {
  buildFixedTokenOptionDescription,
  buildFixedTokenOptionLabel,
  describeTokenBinding,
} from './tokenBindingPresentation.js';

type ChannelSelection = {
  accountId: number;
  tokenId?: number;
  sourceModel?: string;
};

type AddChannelModalProps = {
  open: boolean;
  onClose: () => void;
  routeId: number;
  routeTitle: string;
  candidateView: RouteCandidateView;
  onSuccess: () => void;
  missingTokenHints?: RouteMissingTokenHint[];
  onCreateTokenForMissing?: (accountId: number, modelName: string) => void;
  existingChannelAccountIds?: Set<number>;
};

export default function AddChannelModal({
  open,
  onClose,
  routeId,
  routeTitle,
  candidateView,
  onSuccess,
  missingTokenHints,
  onCreateTokenForMissing,
  existingChannelAccountIds,
}: AddChannelModalProps) {
  const toast = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAccounts, setSelectedAccounts] = useState<Record<number, ChannelSelection>>({});
  const [submitting, setSubmitting] = useState(false);

  const filteredAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return candidateView.accountOptions;
    return candidateView.accountOptions.filter((option) =>
      option.label.toLowerCase().includes(q),
    );
  }, [candidateView.accountOptions, searchQuery]);

  const missingAccounts = useMemo(() => {
    if (!missingTokenHints || missingTokenHints.length === 0) return [];
    const seen = new Map<number, { accountId: number; label: string; modelName: string }>();
    for (const hint of missingTokenHints) {
      for (const account of hint.accounts) {
        if (!seen.has(account.accountId)) {
          const label = `${account.username || `account-${account.accountId}`} @ ${account.siteName}`;
          seen.set(account.accountId, { accountId: account.accountId, label, modelName: hint.modelName });
        }
      }
    }
    return Array.from(seen.values());
  }, [missingTokenHints]);

  const filteredMissingAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return missingAccounts;
    return missingAccounts.filter((item) => item.label.toLowerCase().includes(q));
  }, [missingAccounts, searchQuery]);

  const selectedCount = Object.keys(selectedAccounts).length;

  const toggleAccount = (account: RouteAccountOption) => {
    setSelectedAccounts((prev) => {
      if (prev[account.id]) {
        const next = { ...prev };
        delete next[account.id];
        return next;
      }
      const tokens = candidateView.tokenOptionsByAccountId[account.id] || [];
      return {
        ...prev,
        [account.id]: {
          accountId: account.id,
        },
      };
    });
  };

  const updateTokenForAccount = (accountId: number, tokenId: number, sourceModel: string) => {
    setSelectedAccounts((prev) => {
      if (!prev[accountId]) return prev;
      return {
        ...prev,
        [accountId]: {
          ...prev[accountId],
          tokenId: tokenId || undefined,
          sourceModel: sourceModel || undefined,
        },
      };
    });
  };

  const handleSubmit = async () => {
    const channels = Object.values(selectedAccounts);
    if (channels.length === 0) return;

    setSubmitting(true);
    try {
      const result = await api.batchAddChannels(routeId, channels);
      const msg = `已添加 ${result.created} 个通道` +
        (result.skipped > 0 ? `，跳过 ${result.skipped} 个重复` : '') +
        (result.errors.length > 0 ? `，${result.errors.length} 个错误` : '');
      toast.success(msg);
      setSelectedAccounts({});
      setSearchQuery('');
      onSuccess();
      onClose();
    } catch (e: any) {
      toast.error(e.message || '批量添加通道失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      setSelectedAccounts({});
      setSearchQuery('');
      onClose();
    }
  };

  return (
    <CenteredModal
      open={open}
      onClose={handleClose}
      title={`${tr('添加通道')} - ${routeTitle}`}
      maxWidth={560}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {tr('已选')} {selectedCount} {tr('个通道')}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={handleClose} disabled={submitting}>
              {tr('取消')}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={submitting || selectedCount === 0}
            >
              {submitting ? (
                <><span className="spinner spinner-sm" /> {tr('添加中...')}</>
              ) : (
                `${tr('批量添加')} (${selectedCount})`
              )}
            </button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="toolbar-search" style={{ width: '100%' }}>
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={tr('搜索账号...')}
          />
        </div>

        <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filteredAccounts.length === 0 && filteredMissingAccounts.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: '12px 0', textAlign: 'center' }}>
              {candidateView.accountOptions.length === 0 && missingAccounts.length === 0
                ? tr('当前没有可用的账号，请确认已有账号的令牌支持调用此模型')
                : tr('没有匹配的账号')}
            </div>
          ) : (
            <>
              {filteredAccounts.map((account) => {
                const isSelected = !!selectedAccounts[account.id];
                const tokens = candidateView.tokenOptionsByAccountId[account.id] || [];
                const selection = selectedAccounts[account.id];
                const isExisting = existingChannelAccountIds?.has(account.id);
                const tokenBinding = describeTokenBinding(tokens, selection?.tokenId || 0);

                return (
                  <div
                    key={account.id}
                    onClick={() => toggleAccount(account)}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      background: isSelected ? 'var(--color-primary-light)' : 'var(--color-bg-card)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        style={{ cursor: 'pointer', pointerEvents: 'none' }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{account.label}</span>
                      {isExisting && (
                        <span className="badge badge-muted" style={{ fontSize: 10 }}>{tr('已添加')}</span>
                      )}
                    </div>

                    {isSelected && tokens.length > 0 && (
                      <div style={{ marginTop: 6, paddingLeft: 24 }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>{tr('令牌绑定')}:</div>
                        <ModernSelect
                          size="sm"
                          value={(() => {
                            if (!selection?.tokenId) return '0';
                            return `${selection.tokenId}::${selection.sourceModel || ''}`;
                          })()}
                          onChange={(nextValue) => {
                            if (nextValue === '0') {
                              updateTokenForAccount(account.id, 0, '');
                              return;
                            }
                            const [tokenRaw, ...sourceParts] = nextValue.split('::');
                            updateTokenForAccount(account.id, Number.parseInt(tokenRaw, 10) || 0, sourceParts.join('::'));
                          }}
                          options={[
                            {
                              value: '0',
                              label: tr('跟随账号默认'),
                              description: tokenBinding.followOptionDescription,
                            },
                            ...tokens.map((token: RouteTokenOption) => ({
                              value: `${token.id}::${token.sourceModel || ''}`,
                              label: buildFixedTokenOptionLabel(token, {
                                includeDefaultTag: true,
                                includeSourceModel: true,
                              }),
                              description: buildFixedTokenOptionDescription(token),
                            })),
                          ]}
                          placeholder={tr('选择绑定方式')}
                        />
                        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
                          {tokenBinding.helperText}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Missing token hints */}
              {filteredMissingAccounts.length > 0 && (
                <div style={{ borderTop: '1px dashed var(--color-border)', paddingTop: 8, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 2 }}>
                    {tr('以下账号可用此模型但缺少令牌')}:
                  </div>
                  {filteredMissingAccounts.map((item) => (
                    <div
                      key={item.accountId}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '6px 10px', borderRadius: 'var(--radius-sm)',
                        border: '1px dashed var(--color-border)', background: 'var(--color-bg)',
                      }}
                    >
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{item.label}</span>
                      {onCreateTokenForMissing && (
                        <button
                          type="button"
                          className="btn btn-link"
                          style={{ fontSize: 11, padding: '2px 6px' }}
                          onClick={() => onCreateTokenForMissing(item.accountId, item.modelName)}
                        >
                          {tr('创建令牌')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </CenteredModal>
  );
}
