import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type TooltipSide = 'top' | 'bottom';
type TooltipAlign = 'start' | 'center' | 'end';

type ActiveTooltip = {
  target: HTMLElement;
  text: string;
  side: TooltipSide;
  align: TooltipAlign;
};

type TooltipPosition = {
  left: number;
  top: number;
  arrowLeft: number;
  side: TooltipSide;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readTooltipSide(target: HTMLElement): TooltipSide {
  return target.getAttribute('data-tooltip-side') === 'bottom' ? 'bottom' : 'top';
}

function readTooltipAlign(target: HTMLElement): TooltipAlign {
  const align = target.getAttribute('data-tooltip-align');
  if (align === 'start' || align === 'end') return align;
  return 'center';
}

function resolveTooltipTarget(eventTarget: EventTarget | null): HTMLElement | null {
  if (!(eventTarget instanceof Element)) return null;
  const target = eventTarget.closest<HTMLElement>('[data-tooltip]');
  if (!target) return null;
  const text = target.getAttribute('data-tooltip');
  return text && text.trim() ? target : null;
}

export default function TooltipLayer() {
  const [activeTooltip, setActiveTooltip] = useState<ActiveTooltip | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const cancelFrame = useCallback(() => {
    if (rafRef.current === null || typeof window === 'undefined') return;
    window.cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const hideTooltip = useCallback(() => {
    cancelFrame();
    setActiveTooltip(null);
    setPosition(null);
  }, [cancelFrame]);

  const showTooltipForTarget = useCallback((target: HTMLElement | null) => {
    if (!target) {
      hideTooltip();
      return;
    }
    const text = target.getAttribute('data-tooltip')?.trim();
    if (!text) {
      hideTooltip();
      return;
    }

    setActiveTooltip({
      target,
      text,
      side: readTooltipSide(target),
      align: readTooltipAlign(target),
    });
  }, [hideTooltip]);

  const refreshPosition = useCallback(() => {
    if (!activeTooltip || !bubbleRef.current || typeof window === 'undefined') return;
    if (!activeTooltip.target.isConnected) {
      hideTooltip();
      return;
    }

    const targetRect = activeTooltip.target.getBoundingClientRect();
    const bubbleRect = bubbleRef.current.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 10;

    let left = targetRect.left;
    if (activeTooltip.align === 'center') {
      left = targetRect.left + targetRect.width / 2 - bubbleRect.width / 2;
    } else if (activeTooltip.align === 'end') {
      left = targetRect.right - bubbleRect.width;
    }

    let top = activeTooltip.side === 'bottom'
      ? targetRect.bottom + gap
      : targetRect.top - gap - bubbleRect.height;

    left = clamp(left, viewportPadding, window.innerWidth - viewportPadding - bubbleRect.width);
    top = clamp(top, viewportPadding, window.innerHeight - viewportPadding - bubbleRect.height);

    const targetCenter = targetRect.left + targetRect.width / 2;
    const arrowLeft = clamp(targetCenter - left, 14, bubbleRect.width - 14);

    setPosition({
      left,
      top,
      arrowLeft,
      side: activeTooltip.side,
    });
  }, [activeTooltip, hideTooltip]);

  const scheduleRefresh = useCallback(() => {
    cancelFrame();
    if (typeof window === 'undefined') return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      refreshPosition();
    });
  }, [cancelFrame, refreshPosition]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.dataset.tooltipPortal = 'true';
    return () => {
      delete document.body.dataset.tooltipPortal;
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleMouseOver = (event: MouseEvent) => {
      showTooltipForTarget(resolveTooltipTarget(event.target));
    };

    const handleFocusIn = (event: FocusEvent) => {
      showTooltipForTarget(resolveTooltipTarget(event.target));
    };

    const handleMouseOut = (event: MouseEvent) => {
      if (!activeTooltip) return;
      const nextTarget = resolveTooltipTarget(event.relatedTarget);
      if (nextTarget === activeTooltip.target) return;
      if (event.relatedTarget instanceof Node && activeTooltip.target.contains(event.relatedTarget)) return;
      hideTooltip();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (!activeTooltip) return;
      const nextTarget = resolveTooltipTarget(event.relatedTarget);
      if (nextTarget === activeTooltip.target) return;
      if (event.relatedTarget instanceof Node && activeTooltip.target.contains(event.relatedTarget)) return;
      hideTooltip();
    };

    const handlePointerDown = (event: Event) => {
      if (!activeTooltip) return;
      if (event.target instanceof Node && activeTooltip.target.contains(event.target)) return;
      hideTooltip();
    };

    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('mouseout', handleMouseOut);
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('mouseover', handleMouseOver);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('mouseout', handleMouseOut);
      document.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [activeTooltip, hideTooltip, showTooltipForTarget]);

  useLayoutEffect(() => {
    if (!activeTooltip) return;
    setPosition(null);
    scheduleRefresh();
  }, [activeTooltip, scheduleRefresh]);

  useEffect(() => {
    if (!activeTooltip || typeof window === 'undefined') return;
    if (typeof window.addEventListener !== 'function') return;
    const canRemove = typeof window.removeEventListener === 'function';
    const handleViewportChange = () => scheduleRefresh();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      if (!canRemove) return;
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [activeTooltip, scheduleRefresh]);

  useEffect(() => () => cancelFrame(), [cancelFrame]);

  if (!activeTooltip || typeof document === 'undefined') return null;

  const tooltip = (
    <div className="tooltip-layer" aria-hidden="true">
      <div
        ref={bubbleRef}
        className={`tooltip-bubble tooltip-bubble-${position?.side ?? activeTooltip.side} ${position ? 'is-visible' : ''}`.trim()}
        style={position ? {
          position: 'fixed',
          left: position.left,
          top: position.top,
        } : {
          position: 'fixed',
          left: 0,
          top: 0,
          visibility: 'hidden',
        }}
      >
        {activeTooltip.text}
        <span
          className={`tooltip-bubble-arrow tooltip-bubble-arrow-${position?.side ?? activeTooltip.side}`}
          style={position ? { left: position.arrowLeft } : undefined}
        />
      </div>
    </div>
  );

  return createPortal(tooltip, document.body);
}
