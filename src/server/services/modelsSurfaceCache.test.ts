import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../config.js';
import {
  __getModelsSurfaceCacheSizeForTests,
  buildModelsSurfaceCacheKey,
  invalidateModelsSurfaceCache,
  readModelsSurfaceCache,
  resolveModelsSurfaceCacheTtlMs,
  runModelsSurfaceCompute,
  writeModelsSurfaceCache,
} from './modelsSurfaceCache.js';

describe('modelsSurfaceCache', () => {
  const savedTtl = config.modelsSurfaceCacheTtlMs;

  beforeEach(() => {
    invalidateModelsSurfaceCache();
    config.modelsSurfaceCacheTtlMs = 30_000;
  });

  afterEach(() => {
    config.modelsSurfaceCacheTtlMs = savedTtl;
    invalidateModelsSurfaceCache();
  });

  describe('buildModelsSurfaceCacheKey', () => {
    it('is independent of policy object key order', () => {
      const a = buildModelsSurfaceCacheKey('openai', { type: 'all', siteWeightMultipliers: { 2: 1, 3: 2 } });
      const b = buildModelsSurfaceCacheKey('openai', { siteWeightMultipliers: { 3: 2, 2: 1 }, type: 'all' });
      expect(a).toBe(b);
    });

    it('drops undefined-valued fields (equal policies, same key)', () => {
      const withUndefined = buildModelsSurfaceCacheKey('openai', { type: 'all', denyAllWhenEmpty: undefined });
      const without = buildModelsSurfaceCacheKey('openai', { type: 'all' });
      expect(withUndefined).toBe(without);
    });

    it('separates entries by response format', () => {
      expect(buildModelsSurfaceCacheKey('openai', { type: 'all' }))
        .not.toBe(buildModelsSurfaceCacheKey('claude', { type: 'all' }));
    });

    it('separates entries by policy content, including array order', () => {
      expect(buildModelsSurfaceCacheKey('openai', { supportedModels: ['a', 'b'] }))
        .not.toBe(buildModelsSurfaceCacheKey('openai', { supportedModels: ['b', 'a'] }));
      expect(buildModelsSurfaceCacheKey('openai', { supportedModels: ['a'] }))
        .toBe(buildModelsSurfaceCacheKey('openai', { supportedModels: ['a'] }));
    });
  });

  describe('resolveModelsSurfaceCacheTtlMs', () => {
    it('falls back to the built-in default when config is missing/non-finite', () => {
      delete (config as unknown as Record<string, unknown>).modelsSurfaceCacheTtlMs;
      expect(resolveModelsSurfaceCacheTtlMs()).toBe(30_000);
    });

    it('honours an explicit 0 (cache disabled) instead of the default', () => {
      config.modelsSurfaceCacheTtlMs = 0;
      expect(resolveModelsSurfaceCacheTtlMs()).toBe(0);
    });
  });

  describe('read/write', () => {
    it('serves fresh entries and expires at the TTL boundary', () => {
      writeModelsSurfaceCache('openai|k', ['a'], 1_000);
      expect(readModelsSurfaceCache('openai|k', 1_000)).toEqual(['a']);
      expect(readModelsSurfaceCache('openai|k', 1_000 + 30_000 - 1)).toEqual(['a']);
      expect(readModelsSurfaceCache('openai|k', 1_000 + 30_000)).toBeNull();
      // Expired read removes the entry.
      expect(__getModelsSurfaceCacheSizeForTests()).toBe(0);
    });

    it('never caches empty lists (the refresh-and-reread path must stay live)', () => {
      writeModelsSurfaceCache('openai|empty', [], 1_000);
      expect(readModelsSurfaceCache('openai|empty', 1_000)).toBeNull();
      expect(__getModelsSurfaceCacheSizeForTests()).toBe(0);
    });

    it('writes nothing when the TTL is configured to 0', () => {
      config.modelsSurfaceCacheTtlMs = 0;
      writeModelsSurfaceCache('openai|k', ['a'], 1_000);
      expect(readModelsSurfaceCache('openai|k', 1_000)).toBeNull();
    });
  });

  describe('bounded entries', () => {
    function fill(count: number, start = 0) {
      for (let i = start; i < start + count; i++) {
        writeModelsSurfaceCache(`openai|{"i":${i}}`, [`m${i}`], 1_000);
      }
    }

    it('evicts the oldest entries past the cap', () => {
      fill(65);
      expect(__getModelsSurfaceCacheSizeForTests()).toBe(64);
      expect(readModelsSurfaceCache('openai|{"i":0}', 1_000)).toBeNull();
      expect(readModelsSurfaceCache('openai|{"i":64}', 1_000)).toEqual(['m64']);
    });

    it('a cache read refreshes recency so hot keys survive eviction', () => {
      fill(64);
      expect(readModelsSurfaceCache('openai|{"i":0}', 1_000)).toEqual(['m0']);
      fill(1, 64);
      expect(__getModelsSurfaceCacheSizeForTests()).toBe(64);
      expect(readModelsSurfaceCache('openai|{"i":0}', 1_000)).toEqual(['m0']);
      expect(readModelsSurfaceCache('openai|{"i":1}', 1_000)).toBeNull();
    });
  });

  describe('runModelsSurfaceCompute', () => {
    it('dedupes concurrent misses on the same key into one compute', async () => {
      let calls = 0;
      let settle!: (value: string[]) => void;
      const pending = new Promise<string[]>((resolve) => { settle = resolve; });
      const compute = () => { calls++; return pending; };

      const first = runModelsSurfaceCompute('openai|shared', compute);
      const second = runModelsSurfaceCompute('openai|shared', compute);
      settle(['a']);
      expect(await first).toEqual(['a']);
      expect(await second).toEqual(['a']);
      expect(calls).toBe(1);

      // Slot is released after settle: the next call computes again.
      const third = await runModelsSurfaceCompute('openai|shared', () => { calls++; return Promise.resolve(['b']); });
      expect(third).toEqual(['b']);
      expect(calls).toBe(2);
    });

    it('releases the slot on rejection so a later call can succeed', async () => {
      await expect(runModelsSurfaceCompute('openai|bad', () => Promise.reject(new Error('boom'))))
        .rejects.toThrow('boom');
      const recovered = await runModelsSurfaceCompute('openai|bad', () => Promise.resolve(['ok']));
      expect(recovered).toEqual(['ok']);
    });

    it('runs different keys independently', async () => {
      let calls = 0;
      const compute = () => { calls++; return Promise.resolve([`m${calls}`]); };
      const [a, b] = await Promise.all([
        runModelsSurfaceCompute('openai|a', compute),
        runModelsSurfaceCompute('openai|b', compute),
      ]);
      expect(calls).toBe(2);
      expect(a).not.toEqual(b);
    });
  });
});
