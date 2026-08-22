import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_PAGE_SIZE,
  pageForItemIndex,
  resolveClientPagination,
} from './clientPagination.js';
import { estimateClientPageSize } from './useClientPagination.js';

describe('clientPagination', () => {
  it('uses shared page size of 8', () => {
    expect(CLIENT_PAGE_SIZE).toBe(8);
  });

  it('resolves safe page and slice bounds', () => {
    expect(resolveClientPagination(20, 2)).toEqual({
      pageSize: 8,
      totalPages: 3,
      safePage: 2,
      start: 8,
      end: 16,
    });
    expect(resolveClientPagination(20, 99).safePage).toBe(3);
    expect(resolveClientPagination(0, 3)).toEqual({
      pageSize: 8,
      totalPages: 1,
      safePage: 1,
      start: 0,
      end: 8,
    });
  });

  it('maps item index to 1-based page', () => {
    expect(pageForItemIndex(0)).toBe(1);
    expect(pageForItemIndex(7)).toBe(1);
    expect(pageForItemIndex(8)).toBe(2);
    expect(pageForItemIndex(-1)).toBe(1);
  });
});

describe('estimateClientPageSize', () => {
  it('computes rows from the current viewport height', () => {
    const originalInnerHeight = (globalThis as { innerHeight?: number }).innerHeight;
    (globalThis as { innerHeight?: number }).innerHeight = 1080;
    // 1080 - 64 (topbar) - 180 (chrome) = 836 / 52 ≈ 16 rows
    expect(estimateClientPageSize(8)).toBe(16);
    (globalThis as { innerHeight?: number }).innerHeight = originalInnerHeight;
  });

  it('shrinks the page size for short viewports but never below the minimum', () => {
    const originalInnerHeight = (globalThis as { innerHeight?: number }).innerHeight;
    (globalThis as { innerHeight?: number }).innerHeight = 480;
    expect(estimateClientPageSize(8)).toBe(6);
    (globalThis as { innerHeight?: number }).innerHeight = originalInnerHeight;
  });

  it('clamps to the configured maximum', () => {
    const originalInnerHeight = (globalThis as { innerHeight?: number }).innerHeight;
    (globalThis as { innerHeight?: number }).innerHeight = 3000;
    expect(estimateClientPageSize(8, 6, 12)).toBe(12);
    (globalThis as { innerHeight?: number }).innerHeight = originalInnerHeight;
  });

  it('keeps the fallback when innerHeight is missing', () => {
    const originalInnerHeight = (globalThis as { innerHeight?: number }).innerHeight;
    vi.stubGlobal('innerHeight', undefined);
    expect(estimateClientPageSize(8)).toBe(8);
    (globalThis as { innerHeight?: number }).innerHeight = originalInnerHeight;
    vi.unstubAllGlobals();
  });
});
