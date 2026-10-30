import { tr } from '../../i18n.js';
import CenteredModal from '../../components/CenteredModal.js';

type FactoryResetModalProps = {
  open: boolean;
  factoryResetting: boolean;
  factoryResetSecondsLeft: number;
  adminToken: string;
  onClose: () => void;
  onConfirm: () => void;
};

export default function FactoryResetModal({
  open,
  factoryResetting,
  factoryResetSecondsLeft,
  adminToken,
  onClose,
  onConfirm,
}: FactoryResetModalProps) {
  const confirmLabel = factoryResetting
    ? tr('重新初始化中...')
    : (factoryResetSecondsLeft > 0
      ? `确认重新初始化系统（${factoryResetSecondsLeft}s）`
      : tr('确认重新初始化系统'));

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={tr('确认重新初始化系统')}
      maxWidth={720}
      closeOnBackdrop
      className="modal-danger"
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      footer={
        <>
          <button onClick={onClose} disabled={factoryResetting} className="btn btn-ghost">{tr('取消')}</button>
          <button onClick={onConfirm} disabled={factoryResetting || factoryResetSecondsLeft > 0} className="btn btn-danger">
            {factoryResetting
              ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> {confirmLabel}</>
              : confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ padding: 12, borderRadius: 'var(--radius-sm)', background: 'var(--color-danger-bg)', color: 'var(--color-danger)', fontSize: 12, lineHeight: 1.8 }}>{tr('这是不可逆操作。系统会清空当前 metapi 使用中的全部数据库内容，并在成功后立即退出当前登录状态。')}</div>
      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.9 }}>
        <div>{tr('• 当前若使用外部 MySQL/Postgres，也会先清空该外部库中的 metapi 数据。')}</div>
        <div>{tr('• 系统随后会强制切回默认 SQLite。')}</div>
        <div>{tr('• 管理员 Token 将重置为')} <code style={{ fontFamily: 'var(--font-mono)' }}>{adminToken}</code>。</div>
        <div>{tr('• 完成后会立即退出登录并刷新页面，回到当前首装初始状态。')}</div>
      </div>
    </CenteredModal>
  );
}
