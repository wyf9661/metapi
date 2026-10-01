import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchModelPricingCatalog, refreshModelPricingCatalog } from './modelPricingService.js';

/**
 * Concurrency semantics of the per-site pricing cache:
 *  - single-flight: a cache miss under N concurrent readers performs exactly
 *    ONE upstream fetch (the others share the in-flight promise);
 *  - stale-while-revalidate: when the cache entry has expired, readers get the
 *    previously cached data immediately while a background refresh runs.
 */
describe('pricing cache concurrency', () => {
  let server: ReturnType<typeof createServer>;
  let url: string;
  let upstreamResponses: Array<{ body: string; delayMs: number }>;
  let upstreamCalls = 0;
  let releaseGates: Array<() => void> = [];

  const waitForeverGate = () => new Promise<void>((resolve) => {
    releaseGates.push(resolve);
  });

  beforeEach(async () => {
    upstreamCalls = 0;
    upstreamResponses = [];
    releaseGates = [];
    server = createServer((_request, response) => {
      const spec = upstreamResponses[Math.min(upstreamCalls, upstreamResponses.length - 1)]
        ?? { body: JSON.stringify({ data: [], group_ratio: { default: 1 } }), delayMs: 0 };
      upstreamCalls += 1;
      const respond = () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(spec.body);
      };
      if (spec.delayMs > 0) {
        setTimeout(respond, spec.delayMs);
      } else if (spec.delayMs < 0) {
        // Negative delay = hold the response open until the test releases it.
        waitForeverGate().then(respond);
      } else {
        respond();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const release of releaseGates) release();
    releaseGates = [];
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const catalogInput = (siteId: number) => ({
    site: { id: siteId, url, platform: 'new-api' },
    account: { id: siteId, accessToken: 'session=abc', apiToken: `sk-cache-${siteId}` },
    modelName: '__metadata__',
  });

  it('coalesces concurrent cache misses into a single upstream fetch (single-flight)', async () => {
    // First response is slow so concurrent readers pile up on the same miss.
    upstreamResponses.push({
      body: JSON.stringify({
        data: [{ model_name: 'm1', model_ratio: 1, completion_ratio: 1, quota_type: 0 }],
        group_ratio: { default: 1 },
      }),
      delayMs: 80,
    });

    const siteId = 71_001;
    const [a, b, c] = await Promise.all([
      fetchModelPricingCatalog(catalogInput(siteId)),
      fetchModelPricingCatalog(catalogInput(siteId)),
      fetchModelPricingCatalog(catalogInput(siteId)),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(upstreamCalls).toBe(1);
  });

  it('serves the expired entry immediately and refreshes in the background (stale-while-revalidate)', async () => {
    const siteId = 71_002;
    const payload = (ratio: number) => JSON.stringify({
      data: [{ model_name: 'm1', model_ratio: ratio, completion_ratio: 1, quota_type: 0 }],
      group_ratio: { default: 1 },
    });

    // 1) Prime the cache with ratio 1.
    upstreamResponses.push({ body: payload(1), delayMs: 0 });
    const fresh = await fetchModelPricingCatalog(catalogInput(siteId));
    expect(fresh).not.toBeNull();
    expect(upstreamCalls).toBe(1);

    // 2) Force the entry to look expired WITHOUT wiping it: refreshModelPricingCatalog
    //    is the documented forced-refresh path and rewrites the entry; we instead
    //    simulate expiry by running a manual refresh first so the cache holds data,
    //    then checking that a reader on an EXPIRED entry still sees data fast.
    //    To make the entry genuinely expired we rely on the internal TTL through a
    //    forced refresh: refreshModelPricingCatalog fetches and stores, so we then
    //    backdate by requesting with a fresh module state is not possible —
    //    instead the practical guarantee: while a background refresh is IN
    //    FLIGHT, a reader must receive the stale entry immediately rather than
    //    waiting for the upstream.
    upstreamResponses.push({ body: payload(2), delayMs: -1 }); // held open

    const refreshPromise = refreshModelPricingCatalog(catalogInput(siteId));

    // Give the refresh a moment to start its upstream fetch.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const readerStarted = Date.now();
    const reader = await fetchModelPricingCatalog(catalogInput(siteId));
    const readerElapsed = Date.now() - readerStarted;

    // The reader must NOT block on the in-flight refresh (it would wait for the
    // held-open response otherwise) — it gets the cached entry immediately.
    expect(readerElapsed).toBeLessThan(500);
    expect(reader).not.toBeNull();
    expect(reader!.models.some((m) => m.modelName === 'm1')).toBe(true);

    // Release the held refresh and let it complete.
    for (const release of releaseGates) release();
    const refreshed = await refreshPromise;
    expect(refreshed).not.toBeNull();
    expect(upstreamCalls).toBe(2);
  });

  it('serves an actually expired entry and refreshes it in the background', async () => {
    const siteId = 71_003;
    const payload = (ratio: number) => JSON.stringify({
      data: [{ model_name: 'm1', model_ratio: ratio, completion_ratio: 1, quota_type: 0 }],
      group_ratio: { default: 1 },
    });
    upstreamResponses.push({ body: payload(1), delayMs: 0 });
    const prime = await fetchModelPricingCatalog(catalogInput(siteId));
    expect(prime?.models[0]?.groupPricing.default?.inputPerMillion).toBe(2);
    expect(upstreamCalls).toBe(1);

    // Advance the cache clock beyond its real 10-minute TTL; keep network and
    // HTTP-server timers real so the held upstream response remains deterministic.
    let now = Date.now();
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      now += 11 * 60 * 1_000;
      upstreamResponses.push({ body: payload(3), delayMs: -1 });
      // Old behavior blocks here, waiting for the held upstream request. A
      // short local timeout makes the RED proof finite rather than hanging.
      const stale = await Promise.race([
        fetchModelPricingCatalog(catalogInput(siteId)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
      ]);
      expect(stale?.models[0]?.groupPricing.default?.inputPerMillion).toBe(2);
      await vi.waitFor(() => expect(upstreamCalls).toBe(2));

      for (const release of releaseGates) release();
      // The next read eventually observes the refreshed catalog.
      await vi.waitFor(async () => {
        const refreshed = await fetchModelPricingCatalog(catalogInput(siteId));
        expect(refreshed?.models[0]?.groupPricing.default?.inputPerMillion).toBe(6);
      });
    } finally {
      dateSpy.mockRestore();
      for (const release of releaseGates) release();
    }
  });
});
