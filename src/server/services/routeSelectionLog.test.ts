import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetRecentRouteSelectionsForTests,
  formatRouteSelectionLogLine,
  getRecentRouteSelections,
  logRouteSelection,
} from './routeSelectionLog.js';

describe('routeSelectionLog', () => {
  beforeEach(() => {
    __resetRecentRouteSelectionsForTests();
  });

  it('formats a stable one-line selection audit', () => {
    const line = formatRouteSelectionLogLine({
      requestedModel: 'gpt-5.6-sol',
      selected: {
        channel: { id: 12, routeId: 3, sourceModel: 'gpt-5.6-sol' },
        site: { id: 41, name: 'welfare', platform: 'new-api' },
        account: { id: 9, username: 'u' },
        actualModel: 'gpt-5.6-sol',
      },
      retryCount: 0,
      sticky: false,
      reason: 'primary',
    });
    expect(line).toContain('[route-select]');
    expect(line).toContain('route=3');
    expect(line).toContain('channel=12');
    expect(line).toContain('site=41:welfare');
    expect(line).toContain('sourceModel=gpt-5.6-sol');
    expect(line).toContain('reason=primary');
  });

  it('keeps a recent selection ring buffer for the routes UI', () => {
    logRouteSelection({
      requestedModel: 'gpt-5.6-sol',
      selected: {
        channel: { id: 12, routeId: 3, sourceModel: 'gpt-5.6-sol' },
        site: { id: 41, name: 'welfare', platform: 'new-api' },
        account: { id: 9 },
        actualModel: 'gpt-5.6-sol',
      },
      retryCount: 1,
      sticky: false,
      reason: 'failover',
    });
    const recent = getRecentRouteSelections(5);
    expect(recent).toHaveLength(1);
    expect(recent[0].channelId).toBe(12);
    expect(recent[0].reason).toBe('failover');
    expect(recent[0].siteName).toBe('welfare');
  });
});
