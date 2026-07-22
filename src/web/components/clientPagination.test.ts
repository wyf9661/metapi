import { describe, expect, it } from 'vitest';
import {
  CLIENT_PAGE_SIZE,
  pageForItemIndex,
  resolveClientPagination,
} from './clientPagination.js';

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
