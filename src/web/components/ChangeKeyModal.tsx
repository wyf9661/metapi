import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useToast } from './Toast.js';
import { persistAuthSession } from '../authSession.js';
import { useAnimatedVisibility } from './useAnimatedVisibility.js';

export default function ChangeKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const presence = useAnimatedVisibility(open, 200);
  const [oldToken, setOldToken] = useState('');
  const [newToken, setNewToken] = useState('');
  const [confirmToken, setConfirmToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const handleSubmit = async () => {
    setError('');
    if (!oldToken || !newToken || !confirmToken) {
      setError('请填写所有字段');
      return;
    }
    if (newToken !== confirmToken) {
      setError('两次输入的新 Token 不一致');
      return;
    }
    if (newToken.length < 6) {
      setError('新 Token 至少 6 个字符');
      return;
    }

    setSaving(true);
    try {
      const res = await api.changeAuthToken(oldToken, newToken);
      if (res.success) {
        toast.success('Token 已更新，请使用新 Token 重新登录');
        persistAuthSession(localStorage, newToken);
        onClose();
        setOldToken('');
        setNewToken('');
        setConfirmToken('');
      } else {
        setError(res.message || '更新失败');
      }
    } catch (e: any) {
      setError(e.message || '更新失败');
    } finally {
      setSaving(false);
    }
  };

  if (!presence.shouldRender) return null;

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)', fontSize: 13, outline: 'none',
    background: 'var(--color-bg)', color: 'var(--color-text-primary)',
  };

  const modal = (
    <div className={`modal-backdrop ${presence.isVisible ? '' : 'is-closing'}`.trim()} onClick={onClose}>
      <div className={`modal-content ${presence.isVisible ? '' : 'is-closing'}`.trim()} onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-header">修改管理员 Token</div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>旧 Token</label>
            <input
              type="password"
              value={oldToken}
              onChange={e => { setOldToken(e.target.value); setError(''); }}
              placeholder="输入当前 Token"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>新 Token</label>
            <input
              type="password"
              value={newToken}
              onChange={e => { setNewToken(e.target.value); setError(''); }}
              placeholder="输入新 Token (至少 6 位)"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>确认新 Token</label>
            <input
              type="password"
              value={confirmToken}
              onChange={e => { setConfirmToken(e.target.value); setError(''); }}
              placeholder="再次输入新 Token"
              style={inputStyle}
            />
          </div>

          {error && (
            <div className="alert alert-error">
              {error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="btn btn-ghost">取消</button>
          <button onClick={handleSubmit} disabled={saving} className="btn btn-primary">
            {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />更新中...</> : '确认修改'}
          </button>
        </div>
      </div>
    </div>
  );

  // Skip the portal under the test runner (react-test-renderer cannot host a
  // ReactDOM.createPortal into jsdom's document.body). Mirrors CenteredModal.
  const isTestEnv = import.meta.env.MODE === 'test';
  return !isTestEnv && typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
}
