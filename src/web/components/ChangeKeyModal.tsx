import React, { useState } from 'react';
import { api } from '../api.js';
import { useToast } from './Toast.js';
import { persistAuthSession } from '../authSession.js';
import CenteredModal from './CenteredModal.js';
import { tr } from '../i18n.js';

export default function ChangeKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [oldToken, setOldToken] = useState('');
  const [newToken, setNewToken] = useState('');
  const [confirmToken, setConfirmToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  const handleSubmit = async () => {
    setError('');
    if (!oldToken || !newToken || !confirmToken) {
      setError(tr('请填写所有字段'));
      return;
    }
    if (newToken !== confirmToken) {
      setError(tr('两次输入的新 Token 不一致'));
      return;
    }
    if (newToken.length < 8) {
      setError(tr('新 Token 至少 8 个字符'));
      return;
    }

    setSaving(true);
    try {
      const res = await api.changeAuthToken(oldToken, newToken);
      if (res.success) {
        toast.success(tr('Token 已更新，请使用新 Token 重新登录'));
        persistAuthSession(localStorage, newToken);
        onClose();
        setOldToken('');
        setNewToken('');
        setConfirmToken('');
      } else {
        setError(res.message || tr('更新失败'));
      }
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      setError(eMessage || tr('更新失败'));
    } finally {
      setSaving(false);
    }
  };

  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)', fontSize: 13, outline: 'none',
    background: 'var(--color-bg-inset)', color: 'var(--color-text-primary)',
  };

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={tr('修改管理员 Token')}
      maxWidth={420}
      closeOnBackdrop
      closeOnEscape
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      footer={
        <>
          <button onClick={onClose} className="btn btn-ghost">{tr('取消')}</button>
          <button onClick={handleSubmit} disabled={saving} className="btn btn-primary">
            {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />{tr('更新中...')}</> : tr('确认修改')}
          </button>
        </>
      }
    >
      <div>
        <label style={labelStyle}>{tr('旧 Token')}</label>
        <input
          type="password"
          style={inputStyle}
          value={oldToken}
          onChange={e => { setOldToken(e.target.value); setError(''); }}
          placeholder={tr('输入当前 Token')}
        />
      </div>
      <div>
        <label style={labelStyle}>{tr('新 Token')}</label>
        <input
          type="password"
          style={inputStyle}
          value={newToken}
          onChange={e => { setNewToken(e.target.value); setError(''); }}
          placeholder={tr('输入新 Token (至少 8 位)')}
        />
      </div>
      <div>
        <label style={labelStyle}>{tr('确认新 Token')}</label>
        <input
          type="password"
          style={inputStyle}
          value={confirmToken}
          onChange={e => { setConfirmToken(e.target.value); setError(''); }}
          placeholder={tr('再次输入新 Token')}
        />
      </div>

      {error && (
        <div className="alert alert-error">
          {error}
        </div>
      )}
    </CenteredModal>
  );
}
