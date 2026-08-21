import { describe, expect, it, vi } from 'vitest';
import {
  SQLITE_CACHE_SIZE_KIB,
  SQLITE_MMAP_SIZE_BYTES,
  applySqliteRuntimePragmas,
  optimizeSqlite,
} from './sqlitePragmas.js';

function createConnection(failOn: string[] = []) {
  const calls: string[] = [];
  return {
    calls,
    pragma(source: string) {
      calls.push(source);
      if (failOn.some((needle) => source.includes(needle))) {
        throw new Error(`pragma unsupported: ${source}`);
      }
      return undefined;
    },
  };
}

describe('applySqliteRuntimePragmas', () => {
  it('applies WAL, integrity and read-path tuning pragmas', () => {
    const connection = createConnection();
    const applied = applySqliteRuntimePragmas(connection);

    expect(connection.calls).toEqual([
      'journal_mode = WAL',
      'foreign_keys = ON',
      'busy_timeout = 5000',
      'synchronous = NORMAL',
      `cache_size = -${SQLITE_CACHE_SIZE_KIB}`,
      `mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`,
      'temp_store = MEMORY',
    ]);
    expect(applied).toHaveLength(connection.calls.length);
  });

  it('keeps foreign keys enforced and WAL journaling (correctness invariants)', () => {
    const connection = createConnection();
    applySqliteRuntimePragmas(connection);
    expect(connection.calls).toContain('foreign_keys = ON');
    expect(connection.calls).toContain('journal_mode = WAL');
    // NORMAL (not OFF) — durable across process crashes.
    expect(connection.calls).toContain('synchronous = NORMAL');
    expect(connection.calls).not.toContain('synchronous = OFF');
  });

  it('honours a custom busy timeout', () => {
    const connection = createConnection();
    applySqliteRuntimePragmas(connection, { busyTimeoutMs: 12_000 });
    expect(connection.calls).toContain('busy_timeout = 12000');
  });

  it('continues applying later pragmas when one is unsupported', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connection = createConnection(['mmap_size']);
    const applied = applySqliteRuntimePragmas(connection);

    // The failing pragma is attempted but excluded from the applied list.
    expect(connection.calls).toContain(`mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    expect(applied).not.toContain(`mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    // Startup continues: the pragma after the failure still runs.
    expect(applied).toContain('temp_store = MEMORY');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('optimizeSqlite', () => {
  it('runs PRAGMA optimize', () => {
    const connection = createConnection();
    expect(optimizeSqlite(connection)).toBe(true);
    expect(connection.calls).toEqual(['optimize']);
  });

  it('reports failure without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connection = createConnection(['optimize']);
    expect(optimizeSqlite(connection)).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
