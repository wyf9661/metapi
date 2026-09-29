import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('undici', async (original) => ({ ...await original<typeof import('undici')>(), fetch: state.fetch }));
vi.mock('../siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: string, options: any) => options,
}));

import { NewApiAdapter } from './newApi.js';
import {
  MAX_VARIANT_FAILURES_REPORTED,
  describeUnusableVariantResponse,
  describeVariantError,
  formatVariantFailures,
  logAllVariantsFailed,
} from './platformVariantFailures.js';

describe('platform variant failure diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    state.fetch.mockReset();
  });

  it('names an HTTP status failure', () => {
    expect(describeVariantError(new Error('HTTP 403: forbidden'))).toBe('HTTP 403: forbidden');
  });

  it('names a bounded-request timeout as a timeout', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(describeVariantError(timeout)).toContain('timeout');
  });

  it('reports a placeholder instead of an empty aggregate', () => {
    expect(formatVariantFailures([])).toBe('no variant error recorded');
  });

  it('dedupes, caps and counts omitted variants', () => {
    const failures = Array.from({ length: MAX_VARIANT_FAILURES_REPORTED + 2 }, (_, index) => ({
      variant: `cookie#${index + 1}`,
      reason: 'HTTP 401: invalid session',
    }));
    const formatted = formatVariantFailures(failures);
    expect(formatted.split('; ')).toHaveLength(MAX_VARIANT_FAILURES_REPORTED);
    expect(formatted).toContain('(+2 more)');
  });

  it('logs the scope together with every variant reason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logAllVariantsFailed('getApiTokensByCookie', [{ variant: 'cookie#1', reason: 'HTTP 403: challenge' }]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('getApiTokensByCookie: all variants failed');
    expect(String(warn.mock.calls[0]?.[0])).toContain('cookie#1: HTTP 403: challenge');
  });

  it('reports the per-variant reason from the adapter cookie loop', async () => {
    state.fetch.mockRejectedValue(new Error('HTTP 401: invalid session'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new NewApiAdapter();
    await (adapter as any).getApiTokensByCookie('https://upstream.example', 'session=abc');
    const line = warn.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes('getApiTokensByCookie: all variants failed')) ?? '';
    expect(line).toContain('cookie#1');
    expect(line).toContain('HTTP 401');
  });

  it('distinguishes a 200 response with nothing usable', () => {
    expect(describeUnusableVariantResponse()).toBe('response had no usable data');
    expect(describeUnusableVariantResponse('empty token list')).toBe('empty token list');
  });
});
