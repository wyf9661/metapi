import { describe, expect, it } from 'vitest';
import {
  extractSelfLogItems,
  findBestSelfLogMatch,
  shouldLookupSelfLog,
  type SelfLogItem,
} from './proxyUsageFallbackService.js';

describe('proxyUsageFallbackService', () => {
  it('extracts logs from nested /api/log/self payload', () => {
    const payload = {
      success: true,
      data: {
        data: [
          {
            model_name: 'gpt-4o',
            prompt_tokens: 120,
            completion_tokens: 80,
            quota: 3300,
            created_at: 1_700_000_123,
            request_time: 1450,
          },
        ],
      },
    };

    const logs = extractSelfLogItems(payload);
    expect(logs).toEqual([
      {
        modelName: 'gpt-4o',
        tokenName: '',
        promptTokens: 120,
        completionTokens: 80,
        totalTokens: 200,
        quota: 3300,
        createdAtMs: 1_700_000_123_000,
        requestTimeMs: 1450,
        billingMeta: null,
      },
    ]);
  });

  it('extracts cache billing metadata from self-log other payload', () => {
    const payload = {
      success: true,
      data: {
        items: [
          {
            model_name: 'claude-haiku-4-5-20251001',
            token_name: 'new-api',
            prompt_tokens: 146638,
            completion_tokens: 172,
            quota: 41528,
            created_at: 1_772_790_705,
            request_time: 1700,
            other: JSON.stringify({
              cache_creation_ratio: 1.25,
              cache_creation_tokens: 945,
              cache_ratio: 0.1,
              cache_tokens: 145692,
              completion_ratio: 5,
              group_ratio: 1,
              model_ratio: 2.5,
            }),
          },
        ],
      },
    };

    const logs = extractSelfLogItems(payload);
    expect(logs[0]).toMatchObject({
      modelName: 'claude-haiku-4-5-20251001',
      tokenName: 'new-api',
      promptTokens: 146638,
      completionTokens: 172,
      quota: 41528,
      billingMeta: {
        cacheReadTokens: 145692,
        cacheCreationTokens: 945,
        cacheRatio: 0.1,
        cacheCreationRatio: 1.25,
        completionRatio: 5,
        groupRatio: 1,
        modelRatio: 2.5,
      },
    });
  });

  it('matches best log by model + time window + request time', () => {
    const logs: SelfLogItem[] = [
      {
        modelName: 'gpt-4o',
        tokenName: 'default',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        quota: 1000,
        createdAtMs: 1_700_000_000_000,
        requestTimeMs: 800,
      },
      {
        modelName: 'gpt-4o',
        tokenName: 'default',
        promptTokens: 200,
        completionTokens: 100,
        totalTokens: 300,
        quota: 4500,
        createdAtMs: 1_700_000_007_000,
        requestTimeMs: 3100,
      },
      {
        modelName: 'gpt-4o-mini',
        tokenName: 'default',
        promptTokens: 999,
        completionTokens: 1,
        totalTokens: 1000,
        quota: 9999,
        createdAtMs: 1_700_000_007_000,
        requestTimeMs: 3100,
      },
    ];

    const matched = findBestSelfLogMatch(logs, {
      modelName: 'gpt-4o',
      requestStartedAtMs: 1_700_000_004_000,
      requestEndedAtMs: 1_700_000_008_200,
      localLatencyMs: 3200,
    });

    expect(matched).toEqual(logs[1]);
  });

  it('returns null when no safe match exists', () => {
    const logs: SelfLogItem[] = [
      {
        modelName: 'gpt-4o',
        tokenName: 'default',
        promptTokens: 120,
        completionTokens: 80,
        totalTokens: 200,
        quota: 3300,
        createdAtMs: 1_700_000_123_000,
        requestTimeMs: 1450,
      },
    ];

    const matched = findBestSelfLogMatch(logs, {
      modelName: 'gpt-4o',
      requestStartedAtMs: 1_700_010_000_000,
      requestEndedAtMs: 1_700_010_004_000,
      localLatencyMs: 4000,
    });

    expect(matched).toBeNull();
  });

  it('matches provider-prefixed model names', () => {
    const logs: SelfLogItem[] = [
      {
        modelName: 'z-ai/glm4.7',
        tokenName: 'sys_playground',
        promptTokens: 1095,
        completionTokens: 2179,
        totalTokens: 3274,
        quota: 1890000,
        createdAtMs: 1_772_024_884_000,
        requestTimeMs: 59_000,
      },
    ];

    const matched = findBestSelfLogMatch(logs, {
      modelName: 'glm4.7',
      tokenName: 'windhub',
      requestStartedAtMs: 1_772_024_825_000,
      requestEndedAtMs: 1_772_024_884_500,
      localLatencyMs: 59_000,
    });

    expect(matched).toEqual(logs[0]);
  });


  it('only enables self-log lookup for new-api when usage is missing', () => {
    expect(shouldLookupSelfLog('new-api', { promptTokens: 0, completionTokens: 0, totalTokens: 0 })).toBe(true);
    expect(shouldLookupSelfLog('new-api', { promptTokens: 12, completionTokens: 3, totalTokens: 15 })).toBe(false);
  });

});
