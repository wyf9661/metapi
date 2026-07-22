import { describe, expect, it } from 'vitest';
import {
  buildSiteSaveAction,
  emptySiteApiEndpoint,
  emptySiteCustomHeader,
  applyCodexClientProfile,
  applyCodexCompatibilityMode,
  emptySiteForm,
  isCodexClientProfileEnabled,
  isCodexCompatibilityModeEnabled,
  serializeSiteApiEndpoints,
  serializeSiteCustomHeaders,
  siteFormFromSite,
} from './sitesEditor.js';

describe('buildSiteSaveAction', () => {
  it('returns add action in add mode', () => {
    const action = buildSiteSaveAction(
      { mode: 'add' },
      {
        name: 'site-a',
        url: 'https://a.example.com/',
        platform: 'new-api',
        proxyUrl: 'socks5://127.0.0.1:1080',
        apiEndpoints: [
          { url: 'https://api-a.example.com', enabled: true, sortOrder: 0 },
          { url: 'https://api-b.example.com', enabled: false, sortOrder: 1 },
        ],
        customHeaders: '{"x-site-token":"alpha"}',
        customHeadersOverrideRequestHeaders: true,
        useSystemProxy: false,
        globalWeight: 1.2,
        postRefreshProbeEnabled: true,
        postRefreshProbeModel: 'gpt-4o',
        postRefreshProbeScope: 'single',
        postRefreshProbeLatencyThresholdMs: 2500,
      },
    );

    expect(action).toEqual({
      kind: 'add',
      payload: {
        name: 'site-a',
        url: 'https://a.example.com/',
        platform: 'new-api',
        proxyUrl: 'socks5://127.0.0.1:1080',
        apiEndpoints: [
          { url: 'https://api-a.example.com', enabled: true, sortOrder: 0 },
          { url: 'https://api-b.example.com', enabled: false, sortOrder: 1 },
        ],
        customHeaders: '{"x-site-token":"alpha"}',
        customHeadersOverrideRequestHeaders: true,
        useSystemProxy: false,
        globalWeight: 1.2,
        postRefreshProbeEnabled: true,
        postRefreshProbeModel: 'gpt-4o',
        postRefreshProbeScope: 'single',
        postRefreshProbeLatencyThresholdMs: 2500,
      },
    });
  });

  it('returns update action in edit mode with site id', () => {
    const action = buildSiteSaveAction(
      { mode: 'edit', editingSiteId: 12 },
      {
        name: 'site-b',
        url: 'https://b.example.com',
        platform: 'one-api',
        proxyUrl: '',
        useSystemProxy: true,
        apiEndpoints: [],
        customHeaders: '',
        customHeadersOverrideRequestHeaders: false,
        globalWeight: 0.8,
      },
    );

    expect(action).toEqual({
      kind: 'update',
      id: 12,
      payload: {
        name: 'site-b',
        url: 'https://b.example.com',
        platform: 'one-api',
        proxyUrl: '',
        useSystemProxy: true,
        apiEndpoints: [],
        customHeaders: '',
        customHeadersOverrideRequestHeaders: false,
        globalWeight: 0.8,
      },
    });
  });

  it('throws when edit mode has no site id', () => {
    expect(() =>
      buildSiteSaveAction(
        { mode: 'edit' } as unknown as Parameters<typeof buildSiteSaveAction>[0],
        {
          name: 'site-c',
          url: 'https://c.example.com',
            platform: '',
          proxyUrl: '',
          useSystemProxy: false,
          apiEndpoints: [],
          customHeaders: '',
          customHeadersOverrideRequestHeaders: false,
          globalWeight: 1,
        },
      ),
    ).toThrow('editingSiteId is required in edit mode');
  });

  it('does not expose deprecated apiKey in site editor state', () => {
    const legacySite = {
      name: 'site-d',
      url: 'https://d.example.com',
      platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:8080',
      apiEndpoints: [
        {
          url: 'https://api.example.com',
          enabled: false,
          cooldownUntil: '2026-04-01T00:05:00.000Z',
          lastFailureReason: 'HTTP 502',
        },
      ],
      customHeaders: '{"x-site-token":"alpha"}',
      globalWeight: 1,
      apiKey: 'sk-legacy-site-key',
    } as unknown as Parameters<typeof siteFormFromSite>[0];

    expect(emptySiteForm()).not.toHaveProperty('apiKey');
    expect(emptySiteForm().customHeaders).toEqual([emptySiteCustomHeader()]);
    expect(emptySiteForm().customHeadersOverrideRequestHeaders).toBe(false);
    expect(emptySiteForm().apiEndpoints).toEqual([emptySiteApiEndpoint()]);
    expect(emptySiteForm().proxyUrl).toBe('');
    expect(siteFormFromSite(legacySite)).not.toHaveProperty('apiKey');
    expect(siteFormFromSite({
      proxyUrl: 'http://127.0.0.1:8080',
    }).proxyUrl).toBe('http://127.0.0.1:8080');
    expect(siteFormFromSite({
      customHeadersOverrideRequestHeaders: true,
    }).customHeadersOverrideRequestHeaders).toBe(true);
    expect(siteFormFromSite(legacySite).apiEndpoints).toEqual([
      {
        url: 'https://api.example.com',
        enabled: false,
        cooldownUntil: '2026-04-01T00:05:00.000Z',
        lastFailureReason: 'HTTP 502',
      },
    ]);
  });

  it('parses custom headers json into key value rows', () => {
    expect(siteFormFromSite({
      name: 'site-e',
      customHeaders: '{"x-site-token":"alpha","cf-access-client-id":"beta"}',
    }).customHeaders).toEqual([
      { key: 'x-site-token', value: 'alpha' },
      { key: 'cf-access-client-id', value: 'beta' },
    ]);
  });

  it('serializes key value rows into json', () => {
    expect(serializeSiteCustomHeaders([
      { key: 'x-site-token', value: 'alpha' },
      { key: 'cf-access-client-id', value: 'beta' },
      emptySiteCustomHeader(),
    ])).toEqual({
      valid: true,
      customHeaders: '{"x-site-token":"alpha","cf-access-client-id":"beta"}',
    });
  });

  it('rejects duplicate custom header names case-insensitively', () => {
    expect(serializeSiteCustomHeaders([
      { key: 'Authorization', value: 'Bearer a' },
      { key: 'authorization', value: 'Bearer b' },
    ])).toEqual({
      valid: false,
      customHeaders: '',
      error: '请求头 "authorization" 重复了',
    });
  });

  it('serializes api endpoint rows into ordered payloads', () => {
    expect(serializeSiteApiEndpoints([
      { url: 'https://api-a.example.com/', enabled: true },
      { url: 'https://api-b.example.com', enabled: false },
      emptySiteApiEndpoint(),
    ])).toEqual({
      valid: true,
      apiEndpoints: [
        { url: 'https://api-a.example.com', enabled: true, sortOrder: 0 },
        { url: 'https://api-b.example.com', enabled: false, sortOrder: 1 },
      ],
    });
  });

  it('rejects duplicate api endpoints after normalization', () => {
    expect(serializeSiteApiEndpoints([
      { url: 'https://api.example.com/', enabled: true },
      { url: 'https://api.example.com', enabled: true },
    ])).toEqual({
      valid: false,
      apiEndpoints: [],
      error: 'API 请求地址 "https://api.example.com" 重复了',
    });
  });
});


describe('codex client profile helpers', () => {
  it('applies and detects the preset headers', () => {
    const enabled = applyCodexClientProfile([], true);
    expect(isCodexClientProfileEnabled(enabled)).toBe(true);
    expect(enabled.some((item) => item.key === 'User-Agent' && item.value.includes('codex_cli_rs'))).toBe(true);
    expect(enabled.some((item) => item.key === 'originator' && item.value === 'codex_cli_rs')).toBe(true);

    const disabled = applyCodexClientProfile(enabled, false);
    expect(isCodexClientProfileEnabled(disabled)).toBe(false);
  });

  it('keeps unrelated custom headers when toggling', () => {
    const base = [{ key: 'X-Trace', value: '1' }];
    const enabled = applyCodexClientProfile(base, true);
    expect(enabled.some((item) => item.key === 'X-Trace' && item.value === '1')).toBe(true);
    const disabled = applyCodexClientProfile(enabled, false);
    expect(disabled).toEqual([{ key: 'X-Trace', value: '1' }]);
  });

  it('configures headers and protocol flags through one compatibility switch', () => {
    const base = emptySiteForm();
    const enabled = applyCodexCompatibilityMode(base, true);
    expect(isCodexCompatibilityModeEnabled(enabled)).toBe(true);
    expect(isCodexClientProfileEnabled(enabled.customHeaders)).toBe(true);
    expect(enabled.customHeadersOverrideRequestHeaders).toBe(true);
    expect(enabled.protocolProfile).toEqual({
      preferResponses: true,
      requireCodexClient: true,
      credentialMode: 'auto',
    });

    const disabled = applyCodexCompatibilityMode(enabled, false);
    expect(isCodexCompatibilityModeEnabled(disabled)).toBe(false);
    expect(isCodexClientProfileEnabled(disabled.customHeaders)).toBe(false);
    expect(disabled.protocolProfile.preferResponses).toBe(false);
    expect(disabled.protocolProfile.requireCodexClient).toBe(false);
  });

  it('recognizes legacy sites configured through either protocol flag', () => {
    const form = emptySiteForm();
    expect(isCodexCompatibilityModeEnabled({
      ...form,
      protocolProfile: { ...form.protocolProfile, preferResponses: true },
    })).toBe(true);
    expect(isCodexCompatibilityModeEnabled({
      ...form,
      protocolProfile: { ...form.protocolProfile, requireCodexClient: true },
    })).toBe(true);
  });
});
