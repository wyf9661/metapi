import { useEffect, useState, type ReactNode } from 'react';
import CenteredModal from '../../components/CenteredModal.js';

export type TokenRouteConfirmState = {
  title: string;
  description: ReactNode;
  confirmText: string;
  tone: 'danger' | 'warning';
  dismissLabel?: string;
};

type TokenRouteConfirmModalProps = {
  state: TokenRouteConfirmState | null;
  onCancel: () => void;
  onConfirm: (dismissChecked: boolean) => void;
};

export default function TokenRouteConfirmModal({
  state,
  onCancel,
  onConfirm,
}: TokenRouteConfirmModalProps) {
  const [dismissChecked, setDismissChecked] = useState(false);

  useEffect(() => {
    if (state) setDismissChecked(false);
  }, [state]);

  return (
    <CenteredModal
      open={Boolean(state)}
      onClose={onCancel}
      title={state?.title || '确认操作'}
      maxWidth={460}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>取消</button>
          <button
            type="button"
            className={`btn ${state?.tone === 'danger' ? 'btn-danger' : 'btn-warning'}`}
            onClick={() => onConfirm(dismissChecked)}
          >
            {state?.confirmText || '确认'}
          </button>
        </>
      )}
    >
      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
        {state?.description}
      </div>
      {state?.dismissLabel && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-muted)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={dismissChecked}
            onChange={(event) => setDismissChecked(event.target.checked)}
          />
          {state.dismissLabel}
        </label>
      )}
    </CenteredModal>
  );
}
