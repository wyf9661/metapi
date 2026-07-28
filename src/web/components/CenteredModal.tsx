import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedVisibility } from './useAnimatedVisibility.js';

type CenteredModalProps = {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: number;
  bodyStyle?: React.CSSProperties;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  showCloseButton?: boolean;
};

export default function CenteredModal({
  open,
  onClose,
  title,
  children,
  footer,
  maxWidth = 860,
  bodyStyle,
  closeOnBackdrop = false,
  closeOnEscape = false,
  showCloseButton = true,
}: CenteredModalProps) {
  const presence = useAnimatedVisibility(open, 220);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // Skip the DOM portal under the test runner: web tests render this shell
  // through react-test-renderer, which cannot host a ReactDOM.createPortal
  // into jsdom's document.body ("another renderer is being used"). Vite
  // statically replaces process.env.NODE_ENV, so production/browser builds
  // keep portaling to document.body while vitest renders inline.
  const isTestEnv = import.meta.env.MODE === 'test';
  const canUsePortal = !isTestEnv
    && typeof document !== 'undefined'
    && !!document.body
    && typeof document.body.appendChild === 'function'
    && typeof document.body.removeChild === 'function';

  useEffect(() => {
    if (!open || !canUsePortal) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    queueMicrotask(() => {
      const firstFocusable = dialogRef.current?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      (firstFocusable || dialogRef.current)?.focus();
    });
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [canUsePortal, open]);

  useEffect(() => {
    if (!open || !closeOnEscape || !canUsePortal) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [canUsePortal, closeOnEscape, open, onClose]);

  if (!presence.shouldRender) return null;

  const modal = (
    <div
      className={`modal-backdrop ${presence.isVisible ? '' : 'is-closing'}`.trim()}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={dialogRef}
        className={`modal-content ${presence.isVisible ? '' : 'is-closing'}`.trim()}
        style={{ maxWidth }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div className="modal-title" id={titleId}>{title}</div>
          {showCloseButton ? (
            <button
              type="button"
              className="modal-close-button"
              onClick={onClose}
              aria-label="关闭弹框"
            >
              ×
            </button>
          ) : null}
        </div>
        <div className="modal-body" style={bodyStyle}>
          {children}
        </div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );

  return canUsePortal ? createPortal(modal, document.body) : modal;
}
