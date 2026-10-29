import { describe, expect, it } from 'vitest';
import { buildRouteChannelKey, diffRouteChannels } from './RouteCompareModal.js';
import type { RouteChannel } from './types.js';

function channel(overrides: Partial<RouteChannel> & { id: number }): RouteChannel {
  return {
    accountId: 1,
    tokenId: null,
    sourceModel: 'gpt-4o-mini',
    priority: 0,
    weight: 10,
    enabled: true,
    manualOverride: false,
    successCount: 0,
    failCount: 0,
    ...overrides,
  };
}

describe('route channel diff', () => {
  it('classifies present, missing and reconfigured channels', () => {
    const left = [
      channel({ id: 1, accountId: 1 }),
      channel({ id: 2, accountId: 2 }),
      channel({ id: 3, accountId: 3, weight: 10 }),
    ];
    const right = [
      channel({ id: 11, accountId: 1 }),
      channel({ id: 12, accountId: 3, weight: 50 }),
      channel({ id: 13, accountId: 4 }),
    ];

    const rows = diffRouteChannels(left, right);
    const byAccount = new Map(rows.map((row) => [row.left?.accountId ?? row.right?.accountId, row]));
    expect(byAccount.get(3)?.kind).toBe('changed');
    expect(byAccount.get(1)?.kind).toBe('both');
    expect(byAccount.get(2)?.kind).toBe('left');
    expect(byAccount.get(4)?.kind).toBe('right');
    // Ordering: differences first, identical rows last.
    expect(rows[rows.length - 1].kind).toBe('both');
  });

  it('keys a channel by account + token + source model', () => {
    expect(buildRouteChannelKey(channel({ id: 1, accountId: 7, tokenId: 9, sourceModel: ' GPT-4O ' })))
      .toBe('7:9::gpt-4o');
    expect(buildRouteChannelKey(channel({ id: 1, accountId: 7, tokenId: null })))
      .toBe('7:account::gpt-4o-mini');
  });

  it('treats counters alone as identical', () => {
    const left = [channel({ id: 1, successCount: 10, failCount: 2 })];
    const right = [channel({ id: 1, successCount: 99, failCount: 30 })];
    expect(diffRouteChannels(left, right).map((row) => row.kind)).toEqual(['both']);
  });
});
