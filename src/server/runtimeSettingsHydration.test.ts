import { afterEach, describe, expect, it } from 'vitest';

import { config } from './config.js';
import { applyRuntimeSettings } from './runtimeSettingsHydration.js';

const originalConfig = structuredClone(config);

afterEach(() => {
  Object.assign(config, structuredClone(originalConfig));
});

describe('applyRuntimeSettings', () => {
  it('hydrates persisted runtime settings that should survive restarts', () => {
    config.disableCrossProtocolFallback = false;
    config.responsesCompactFallbackToResponsesEnabled = false;
    config.webhookEnabled = true;
    config.serverChanEnabled = true;

    applyRuntimeSettings(new Map([
      ['disable_cross_protocol_fallback', JSON.stringify(true)],
      ['responses_compact_fallback_to_responses_enabled', JSON.stringify(true)],
      ['webhook_enabled', JSON.stringify(false)],
      ['notify_channels', JSON.stringify([{ id: 'ch-1', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', secret: 's', enabled: true, kind: 'feishu' }])],
      ['serverchan_enabled', JSON.stringify(false)],
    ]));

    expect(config.disableCrossProtocolFallback).toBe(true);
    expect(config.responsesCompactFallbackToResponsesEnabled).toBe(true);
    expect(config.webhookEnabled).toBe(false);
    expect(config.notifyChannels).toEqual([
      { id: 'ch-1', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', secret: 's', enabled: true, kind: 'feishu' },
    ]);
    expect(config.serverChanEnabled).toBe(false);
  });

  it('normalizes smtpPort to a positive integer during hydration', () => {
    config.smtpPort = 587;

    applyRuntimeSettings(new Map([
      ['smtp_port', JSON.stringify(587.9)],
    ]));

    expect(config.smtpPort).toBe(587);
  });
});
