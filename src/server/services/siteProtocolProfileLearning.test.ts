import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMock, runMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  runMock: vi.fn(),
}));

vi.mock('../db/index.js', () => {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.get = (...args: unknown[]) => getMock(...args);
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.run = (...args: unknown[]) => runMock(...args);
  return {
    db: chain,
    schema: {
      sites: {
        id: 'id',
        platform: 'platform',
        protocolProfile: 'protocolProfile',
        updatedAt: 'updatedAt',
      },
    },
  };
});

vi.mock('./tokenRouter.js', () => ({
  invalidateTokenRouterCache: vi.fn(),
}));

import {
  learnSitePreferResponses,
  mergePreferResponsesProfile,
  resetSiteProtocolProfileLearningStateForTests,
  shouldLearnPreferResponses,
} from './siteProtocolProfileLearning.js';

describe('siteProtocolProfileLearning', () => {
  beforeEach(() => {
    getMock.mockReset();
    runMock.mockReset();
    resetSiteProtocolProfileLearningStateForTests();
  });

  it('detects learnable success and codex policy failures', () => {
    expect(shouldLearnPreferResponses({
      platform: 'new-api',
      endpoint: 'responses',
      reason: 'responses_success',
    })).toBe(true);
    expect(shouldLearnPreferResponses({
      platform: 'new-api',
      endpoint: 'chat',
      reason: 'responses_success',
    })).toBe(false);
    expect(shouldLearnPreferResponses({
      platform: 'claude',
      endpoint: 'responses',
      reason: 'responses_success',
    })).toBe(false);
    expect(shouldLearnPreferResponses({
      platform: 'new-api',
      reason: 'codex_policy_failure',
      errorText: 'codex_requires_responses_protocol',
    })).toBe(true);
  });

  it('mergePreferResponsesProfile flips preferResponses without wiping credentialMode', () => {
    const merged = mergePreferResponsesProfile(JSON.stringify({
      preferResponses: false,
      requireCodexClient: false,
      credentialMode: 'session',
    }), { requireCodexClient: true });
    expect(merged.preferResponses).toBe(true);
    expect(merged.requireCodexClient).toBe(true);
    expect(merged.credentialMode).toBe('session');
  });

  it('persists preferResponses when site lacks the flag', async () => {
    getMock.mockReturnValue({
      id: 9,
      platform: 'new-api',
      protocolProfile: null,
    });
    runMock.mockReturnValue(undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const wrote = await learnSitePreferResponses({
      siteId: 9,
      platform: 'new-api',
      endpoint: 'responses',
      reason: 'responses_success',
      nowMs: 1_000,
    });
    infoSpy.mockRestore();
    expect(wrote).toBe(true);
    expect(getMock).toHaveBeenCalled();
    expect(runMock).toHaveBeenCalled();
  });

  it('skips write when preferResponses already true', async () => {
    getMock.mockReturnValue({
      id: 9,
      platform: 'new-api',
      protocolProfile: JSON.stringify({
        preferResponses: true,
        requireCodexClient: false,
        credentialMode: 'auto',
      }),
    });

    const wrote = await learnSitePreferResponses({
      siteId: 9,
      platform: 'new-api',
      endpoint: 'responses',
      reason: 'responses_success',
      nowMs: 1_000,
    });
    expect(wrote).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('debounces repeated learns for the same site', async () => {
    getMock.mockReturnValue({
      id: 9,
      platform: 'new-api',
      protocolProfile: null,
    });
    runMock.mockReturnValue(undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await learnSitePreferResponses({
      siteId: 9,
      platform: 'new-api',
      endpoint: 'responses',
      reason: 'responses_success',
      nowMs: 1_000,
    });
    const second = await learnSitePreferResponses({
      siteId: 9,
      platform: 'new-api',
      endpoint: 'responses',
      reason: 'responses_success',
      nowMs: 2_000,
    });
    infoSpy.mockRestore();
    expect(second).toBe(false);
  });
});
