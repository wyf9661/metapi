import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type HoverPopoverProps = {
  /** Floating content. Kept interactive: hovering it keeps the popover open. */
  content: React.ReactNode;
  /** The trigger element(s). */
  children: React.ReactNode;
  testId?: string;
  maxWidth?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A small floating card anchored to its trigger: hover opens it on a pointer
 * device, tap toggles it on touch. Positioning follows `TooltipLayer` (same 12px
 * viewport padding and above-then-below flip) so the two read as one family; the
 * content is real markup rather than a `data-tooltip` string.
 */
export default function HoverPopover({
  content,
  children,
  testId,
  maxWidth = 320,
}: HoverPopoverProps) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null || typeof window === 'undefined') return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const close = useCallback(() => {
    cancelClose();
    setOpen(false);
    setPosition(null);
  }, [cancelClose]);

  /** Leave grace period: the pointer must be able to travel into the card. */
  const scheduleClose = useCallback(() => {
    if (typeof window === 'undefined') return;
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
      setPosition(null);
    }, 140);
  }, [cancelClose]);

  const refreshPosition = useCallback(() => {
    if (typeof window === 'undefined') return;
    const anchor = anchorRef.current;
    const card = cardRef.current;
    if (!anchor || !card) return;

    const anchorRect = anchor.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 10;

    const left = clamp(
      anchorRect.left + anchorRect.width / 2 - cardRect.width / 2,
      viewportPadding,
      Math.max(viewportPadding, window.innerWidth - viewportPadding - cardRect.width),
    );
    const roomAbove = anchorRect.top - gap - cardRect.height;
    const top = roomAbove >= viewportPadding
      ? roomAbove
      : clamp(
        anchorRect.bottom + gap,
        viewportPadding,
        Math.max(viewportPadding, window.innerHeight - viewportPadding - cardRect.height),
      );

    setPosition({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    refreshPosition();
    return undefined;
  }, [open, refreshPosition]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;

    const handlePointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || cardRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const handleViewportChange = () => close();

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange);
    };
  }, [open, close]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  return (
    <>
      <span
        ref={anchorRef}
        style={{ display: 'inline-flex', alignItems: 'center' }}
        onPointerEnter={(event) => {
          if (event.pointerType && event.pointerType !== 'mouse') return;
          cancelClose();
          setOpen(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType && event.pointerType !== 'mouse') return;
          scheduleClose();
        }}
        onClick={(event) => {
          // Toggle on tap; never let the row underneath react to it.
          event.stopPropagation();
          if (open) {
            close();
            return;
          }
          cancelClose();
          setOpen(true);
        }}
      >
        {children}
      </span>

      {open && typeof document !== 'undefined' ? createPortal(
        <div
          ref={cardRef}
          data-testid={testId}
          role="tooltip"
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          style={{
            position: 'fixed',
            left: position?.left ?? -9999,
            top: position?.top ?? -9999,
            maxWidth: `min(${maxWidth}px, calc(100vw - 24px))`,
            padding: '8px 10px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid color-mix(in srgb, var(--color-primary) 22%, transparent)',
            background: 'color-mix(in srgb, #ffffff 94%, var(--color-primary) 6%)',
            boxShadow: '0 12px 30px rgba(28,25,23, 0.14)',
            color: 'var(--color-text-primary)',
            fontSize: 11,
            lineHeight: 1.45,
            zIndex: 20000,
            visibility: position ? 'visible' : 'hidden',
          }}
        >
          {content}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
