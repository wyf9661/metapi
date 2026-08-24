import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  pageForItemIndex,
  resolveClientPagination,
  snapToPageSizeOptions,
} from './clientPagination.js';
import { estimateClientPageSize } from './useClientPagination.js';

describe('clientPagination', () => {
  it('uses shared page size of 8', () => {
    expect(CLIENT_PAGE_SIZE).toBe(8);
  });

  it('exports valid page size options', () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([5, 10, 20, 50]);
    expect(DEFAULT_PAGE_SIZE).toBe(10);
  });

  it('snaps values to the nearest option', () => {
    expect(snapToPageSizeOptions(10)).toBe(10);
    expect(snapToPageSizeOptions(8)).toBe(10);  // 10 is closer than 5
    expect(snapToPageSizeOptions(6)).toBe(5);   // 5 is closer than 10
    expect(snapToPageSizeOptions(30)).toBe(20); // 20 is closer than 50
    expect(snapToPageSizeOptions(40)).toBe(50); // 50 is closer than 20
    expect(snapToPageSizeOptions(-1)).toBe(10); // fallback to default
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
  it('computes rows from the current viewport height and snaps to options', () => {
    const originalInnerHeight = (globalThis as { innerHeight?: number }).innerHeight;
    (globalThis as { innerHeight?: number }).innerHeight = 1080;
    // 1080 - 64 (topbar) - 180 (chrome) = 836 / 52 ≈ 16 → nearest option is 20
    expect(estimateClientPageSize(8)).toBe(20);
    (globalThis as { innerHeight?: number }).innerHeight = originalInnerHeight;
  });

  it('snaps to 5 for very short viewports', () => {
    const originalInnerHeight = (globalThis as { innerHeight?: number }).innerHeight;
    (globalThis as { innerHeight?: number }).innerHeight = 480;
    // 480 - 64 - 180 = 236 / 52 ≈ 4.5 → clamped to min=6 → nearest option is 5
    expect(estimateClientPageSize(8)).toBe(5);
    (globalThis as { innerHeight?: number }).innerHeight = originalInnerHeight;
  });

  it('clamps to the configured maximum and snaps', () => {
    const originalInnerHeight = (globalThis as { innerHeight?: number }).innerHeight;
    (globalThis as { innerHeight?: number }).innerHeight = 3000;
    // 3000 - 64 - 180 = 2756 / 52 ≈ 53 → clamped to max=12 → nearest option is 10
    expect(estimateClientPageSize(8, 6, 12)).toBe(10);
    (globalThis as { innerHeight?: number }).innerHeight = originalInnerHeight;
  });

  it('falls back to default when innerHeight is missing', () => {
    const originalInnerHeight = (globalThis as { innerHeight?: number }).innerHeight;
    vi.stubGlobal('innerHeight', undefined);
    expect(estimateClientPageSize(8)).toBe(10);
    (globalThis as { innerHeight?: number }).innerHeight = originalInnerHeight;
    vi.unstubAllGlobals();
  });
});