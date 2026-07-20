import { describe, expect, it } from 'vitest';
import {
  detectSiteInitializationPreset,
  listSiteInitializationPresets,
} from './siteInitializationPresets.js';

describe('siteInitializationPresets', () => {
  it('keeps vendor initialization presets disabled', () => {
    expect(listSiteInitializationPresets()).toEqual([]);
  });

  it('does not infer vendor presets from official or custom URLs', () => {
    expect(detectSiteInitializationPreset('https://coding.dashscope.aliyuncs.com/v1')).toBeNull();
    expect(detectSiteInitializationPreset('https://open.bigmodel.cn/api/coding/paas/v4')).toBeNull();
    expect(detectSiteInitializationPreset('https://api.deepseek.com/v1', 'openai')).toBeNull();
    expect(detectSiteInitializationPreset('https://gateway.example.com/v1', 'openai')).toBeNull();
  });
});
