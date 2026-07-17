import { describe, expect, it } from 'vitest';
import { formatRouteSelectionLogLine } from './routeSelectionLog.js';

describe('routeSelectionLog', () => {
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
});
