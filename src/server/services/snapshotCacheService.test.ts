import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSnapshotCache,
  readSnapshotCache,
  type PersistedSnapshotRecord,
} from "./snapshotCacheService.js";

describe("snapshotCacheService", () => {
  let previousVitestEnv: string | undefined;

  beforeEach(() => {
    previousVitestEnv = process.env.VITEST;
    delete process.env.VITEST;
    clearSnapshotCache();
  });

  afterEach(() => {
    if (previousVitestEnv === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = previousVitestEnv;
    }
  });

  it("degrades persistence read and write failures without breaking the read path", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await readSnapshotCache({
      namespace: "test",
      key: "persistence-failure",
      ttlMs: 1000,
      loader: async () => ({ ok: true }),
      persistence: {
        read: async () => {
          throw new Error("read failed");
        },
        write: async () => {
          throw new Error("write failed");
        },
      },
    });

    expect(result.payload).toEqual({ ok: true });
    expect(result.cacheStatus).toBe("miss");
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("reuses an in-flight loader after async hydration misses", async () => {
    let loaderCalls = 0;
    const persistenceRead = vi.fn(async (): Promise<PersistedSnapshotRecord<number> | null> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return null;
    });

    const [left, right] = await Promise.all([
      readSnapshotCache({
        namespace: "test",
        key: "coalesce",
        ttlMs: 1000,
        loader: async () => {
          loaderCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 42;
        },
        persistence: {
          read: persistenceRead,
          write: async () => {},
        },
      }),
      readSnapshotCache({
        namespace: "test",
        key: "coalesce",
        ttlMs: 1000,
        loader: async () => {
          loaderCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 42;
        },
        persistence: {
          read: persistenceRead,
          write: async () => {},
        },
      }),
    ]);

    expect(left.payload).toBe(42);
    expect(right.payload).toBe(42);
    expect(loaderCalls).toBe(1);
  });
});
