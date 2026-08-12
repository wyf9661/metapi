import React, { useState } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import ResponsiveFormGrid from '../../components/ResponsiveFormGrid.js';
import ModernSelect from '../../components/ModernSelect.js';
import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 13,
  outline: 'none',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
};

function parseAccountExtraConfig(account: any): Record<string, any> {
  try {
    return JSON.parse(account?.extraConfig || '{}') || {};
  } catch {
    return {};
  }
}

function extractManagedSub2ApiAuth(account: any) {
  const parsed = parseAccountExtraConfig(account);
  const auth = parsed?.sub2apiAuth || {};
  return {
    refreshToken:
      typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    tokenExpiresAt: auth.tokenExpiresAt ? String(auth.tokenExpiresAt) : '',
  };
}

type EditAccountModalProps = {
  open: boolean;
  account: any | null;
  onClose: () => void;
  onSaved: () => void;
};

export default function EditAccountModal({
  open,
  account,
  onClose,
  onSaved,
}: EditAccountModalProps) {
  const toast = useToast();
  const [editForm, setEditForm] = useState({
    username: '',
    status: 'active' as 'active' | 'disabled' | 'expired',
    checkinEnabled: true,
    unitCost: '',
    accessToken: '',
    apiToken: '',
    isPinned: false,
    refreshToken: '',
    tokenExpiresAt: '',
    platformUserId: '',
  });
  const [savingEdit, setSavingEdit] = useState(false);

  // Sync form when account changes
  const lastAccountIdRef = React.useRef<number | null>(null);
  if (account && account.id !== lastAccountIdRef.current) {
    lastAccountIdRef.current = account.id;
    const managedAuth = extractManagedSub2ApiAuth(account);
    const nextForm = {
      username: account?.username || '',
      status: (account?.status === 'disabled' || account?.status === 'expired'
        ? account.status
        : 'active') as 'active' | 'disabled' | 'expired',
      checkinEnabled: account?.checkinEnabled !== false,
      unitCost:
        account?.unitCost === null || account?.unitCost === undefined
          ? ''
          : String(account.unitCost),
      accessToken: account?.accessToken || '',
      apiToken: account?.apiToken || '',
      isPinned: !!account?.isPinned,
      refreshToken: managedAuth.refreshToken,
      tokenExpiresAt: managedAuth.tokenExpiresAt,
      platformUserId: account?.platformUserId ? String(account.platformUserId) : '',
    };
    if (JSON.stringify(nextForm) !== JSON.stringify(editForm)) {
      setEditForm(nextForm);
    }
  }
  if (!account && lastAccountIdRef.current !== null) {
    lastAccountIdRef.current = null;
  }

  const handleClose = () => {
    setSavingEdit(false);
    onClose();
  };

  const handleSave = async () => {
    if (!account) return;
    setSavingEdit(true);
    try {
      await api.updateAccount(account.id, {
        username: editForm.username.trim() || undefined,
        status: editForm.status,
        checkinEnabled: editForm.checkinEnabled,
        unitCost: editForm.unitCost.trim()
          ? Number(editForm.unitCost.trim())
          : null,
        accessToken: editForm.accessToken.trim(),
        apiToken: editForm.apiToken.trim() || null,
        isPinned: editForm.isPinned,
        refreshToken: editForm.refreshToken.trim() || null,
        tokenExpiresAt: editForm.tokenExpiresAt.trim()
          ? Number.parseInt(editForm.tokenExpiresAt.trim(), 10)
          : null,
        platformUserId: editForm.platformUserId.trim()
          ? Number.parseInt(editForm.platformUserId.trim(), 10)
          : null,
      });
      toast.success('账号已更新');
      handleClose();
      onSaved();
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || '更新账号失败');
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <CenteredModal
      open={open}
      onClose={handleClose}
      title="编辑账号"
      maxWidth={860}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      footer={
        <>
          <button onClick={handleClose} className="btn btn-ghost">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={savingEdit}
            className="btn btn-primary"
          >
            {savingEdit ? (
              <>
                <span
                  className="spinner spinner-sm"
                  style={{
                    borderTopColor: 'white',
                    borderColor: 'rgba(255,255,255,0.3)',
                  }}
                />{' '}
                保存中...
              </>
            ) : (
              '保存修改'
            )}
          </button>
        </>
      }
    >
      {account ? (
        <ResponsiveFormGrid>
          <input
            placeholder="账号名称"
            value={editForm.username}
            onChange={(e) =>
              setEditForm((prev) => ({
                ...prev,
                username: e.target.value,
              }))
            }
            style={inputStyle}
          />
          <ModernSelect
            value={editForm.status}
            onChange={(value) =>
              setEditForm((prev) => ({
                ...prev,
                status: (value === 'disabled' || value === 'expired'
                  ? value
                  : 'active') as 'active' | 'disabled' | 'expired',
              }))
            }
            options={[
              { value: 'active', label: 'active' },
              { value: 'disabled', label: 'disabled' },
              { value: 'expired', label: 'expired' },
            ]}
            placeholder="状态"
          />
          <input
            placeholder="单位成本（可选）"
            value={editForm.unitCost}
            onChange={(e) =>
              setEditForm((prev) => ({
                ...prev,
                unitCost: e.target.value,
              }))
            }
            style={inputStyle}
          />
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              ...inputStyle,
            }}
          >
            <input
              type="checkbox"
              checked={editForm.checkinEnabled}
              onChange={(e) =>
                setEditForm((prev) => ({
                  ...prev,
                  checkinEnabled: e.target.checked,
                }))
              }
            />
            启用签到
          </label>
          <input
            placeholder="Access Token"
            value={editForm.accessToken}
            onChange={(e) =>
              setEditForm((prev) => ({
                ...prev,
                accessToken: e.target.value,
              }))
            }
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
          />
          {(account?.site?.platform || '').toLowerCase() === 'new-api' && (
            <input
              placeholder="用户 ID"
              value={editForm.platformUserId}
              onChange={(e) =>
                setEditForm((prev) => ({
                  ...prev,
                  platformUserId: e.target.value.replace(/\D/g, ''),
                }))
              }
              style={inputStyle}
            />
          )}
          <input
            placeholder="API Token（可选）"
            value={editForm.apiToken}
            onChange={(e) =>
              setEditForm((prev) => ({
                ...prev,
                apiToken: e.target.value,
              }))
            }
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
          />
          {(account?.site?.platform || '').toLowerCase() === 'sub2api' && (
            <>
              <input
                placeholder="refresh_token"
                value={editForm.refreshToken}
                onChange={(e) =>
                  setEditForm((prev) => ({
                    ...prev,
                    refreshToken: e.target.value,
                  }))
                }
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
              />
              <input
                placeholder="token_expires_at"
                value={editForm.tokenExpiresAt}
                onChange={(e) =>
                  setEditForm((prev) => ({
                    ...prev,
                    tokenExpiresAt: e.target.value.replace(/\D/g, ''),
                  }))
                }
                style={inputStyle}
              />
            </>
          )}
        </ResponsiveFormGrid>
      ) : null}
    </CenteredModal>
  );
}
