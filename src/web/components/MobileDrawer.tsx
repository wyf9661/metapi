import React, { useEffect, useId, useMemo, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

type MobileDrawerProps = {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: React.ReactNode;
  closeLabel?: string;
  side?: 'left' | 'right';
};

function MobileDrawer({
  open,
  onClose,
  children,
  title,
  closeLabel = '关闭导航',
  side = 'left',
}: MobileDrawerProps) {
  const [shouldRender, setShouldRender] = useState(open);
  const [isClosing, setIsClosing] = useState(false);
  const titleId = useId();
  const labelledBy = title ? titleId : undefined;

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      setIsClosing(false);
    } else if (shouldRender) {
      setIsClosing(true);
      const timer = setTimeout(() => {
        setShouldRender(false);
        setIsClosing(false);
      }, 280);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClose();
      }
    };
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [handleClose, open]);

  if (!shouldRender) return null;

  const drawer = (
    <div className={`mobile-drawer-root ${isClosing ? 'is-closing' : ''}`}>
      <div
        className="mobile-drawer-backdrop"
        onClick={handleClose}
        aria-hidden="true"
      />
      <div className={`mobile-drawer-panel mobile-drawer-panel-${side}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <div className="mobile-drawer-toolbar">
          {title ? (
            <div className="mobile-drawer-title" id={titleId}>
              {title}
            </div>
          ) : <div />}
          <button type="button" className="mobile-drawer-close" onClick={handleClose} aria-label={closeLabel}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );

  const portalTarget = typeof document !== 'undefined' ? document.body : null;
  return portalTarget ? createPortal(drawer, portalTarget) : drawer;
}

export { MobileDrawer };
export default MobileDrawer;
