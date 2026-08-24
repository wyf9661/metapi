import { useCallback, useEffect, useState } from 'react';
import { useIsMobile } from './useIsMobile.js';

/** Page-size choices offered across list/log pages. */
export const PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100];

/** Desktop default rows-per-page. */
export const DESKTOP_DEFAULT_PAGE_SIZE = 10;

/** Mobile default rows-per-page (smaller viewport, fewer rows). */
export const MOBILE_DEFAULT_PAGE_SIZE = 5;

const STORAGE_PREFIX = 'metapi.pageSize';

function storageKey(scope: string, isMobile: boolean): string {
  return `${STORAGE_PREFIX}.${scope}.${isMobile ? 'mobile' : 'desktop'}`;
}

function readStored(scope: string, isMobile: boolean): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(scope, isMobile));
    const parsed = Number.parseInt(raw || '', 10);
    return PAGE_SIZE_OPTIONS.includes(parsed) ? parsed : null;
  } catch {
    // localStorage can throw in private mode / when storage is disabled.
    return null;
  }
}

function writeStored(scope: string, isMobile: boolean, value: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(scope, isMobile), String(value));
  } catch {
    // Persistence is best-effort; ignore quota/permission failures.
  }
}

/**
 * Rows-per-page state that remembers the user's choice in localStorage and
 * defaults by form factor (desktop 10 / mobile 5).
 *
 * `scope` namespaces the stored value so each surface (sites, proxy logs,
 * probe logs, ...) keeps its own preference. Desktop and mobile are stored
 * separately so switching form factor does not clobber the other default.
 */
export function usePersistedPageSize(
  scope: string,
): [number, (next: number) => void] {
  const isMobile = useIsMobile();
  const fallback = isMobile ? MOBILE_DEFAULT_PAGE_SIZE : DESKTOP_DEFAULT_PAGE_SIZE;
  const [pageSize, setPageSize] = useState<number>(
    () => readStored(scope, isMobile) ?? fallback,
  );

  // Re-resolve when the form factor changes (rotate / resize across the
  // mobile breakpoint): prefer that form factor's stored value, else its default.
  useEffect(() => {
    const resolved = readStored(scope, isMobile) ?? fallback;
    setPageSize((current) => (current === resolved ? current : resolved));
  }, [scope, isMobile, fallback]);

  const update = useCallback(
    (next: number) => {
      const normalized = PAGE_SIZE_OPTIONS.includes(next) ? next : fallback;
      setPageSize(normalized);
      writeStored(scope, isMobile, normalized);
    },
    [scope, isMobile, fallback],
  );

  return [pageSize, update];
}
