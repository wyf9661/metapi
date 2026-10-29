import React from 'react';
import CenteredModal from './CenteredModal.js';
import { tr } from '../i18n.js';

type DeleteConfirmModalProps = {
  open: boolean;
  title?: string;
  description: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export default function DeleteConfirmModal({
  open,
  title = '确认删除',
  description,
  confirmText = '确认删除',
  cancelText = '取消',
  loading = false,
  onConfirm,
  onClose,
}: DeleteConfirmModalProps) {
  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={title}
      maxWidth={560}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      footer={(
        <>
          <button onClick={onClose} className="btn btn-ghost" disabled={loading}>{cancelText}</button>
          <button onClick={onConfirm} className="btn btn-danger" disabled={loading}>
            {loading
              ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> {tr('删除中...')}</>
              : confirmText}
          </button>
        </>
      )}
    >
      <div className="alert alert-error" style={{ margin: 0 }}>
        <div className="alert-title">{tr('此操作不可撤销')}</div>
        <div style={{ marginTop: 6, fontSize: 13 }}>{description}</div>
      </div>
    </CenteredModal>
  );
}
