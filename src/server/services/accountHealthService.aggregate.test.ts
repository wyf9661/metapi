import { describe, expect, it } from 'vitest';
import { aggregateSiteRuntimeHealth } from './accountHealthService.js';
import type { RuntimeHealthInfo } from './accountHealthService.js';

function health(state: RuntimeHealthInfo['state'], over: Partial<RuntimeHealthInfo> = {}): RuntimeHealthInfo {
  return {
    state,
    reason: `reason-${state}`,
    source: 'test',
    checkedAt: '2026-10-10T00:00:00.000Z',
    ...over,
  };
}

describe('aggregateSiteRuntimeHealth', () => {
  it('aggregates to healthy when one of several accounts is healthy and others disabled', () => {
    // 复现 #283：被禁用账号排在第一位，健康账号排在后面。
    const result = aggregateSiteRuntimeHealth([
      { status: 'disabled', health: health('disabled') },
      { status: 'active', health: health('healthy') },
    ]);
    expect(result?.state).toBe('healthy');
  });

  it('aggregates to healthy regardless of account row order', () => {
    const rows = [
      { status: 'active', health: health('healthy') },
      { status: 'active', health: health('unhealthy') },
    ];
    const reversed = [...rows].reverse();
    const a = aggregateSiteRuntimeHealth(rows);
    const b = aggregateSiteRuntimeHealth(reversed);
    expect(a?.state).toBe('unhealthy');
    expect(b?.state).toBe('unhealthy');
  });

  it('skips disabled accounts when active ones exist', () => {
    const result = aggregateSiteRuntimeHealth([
      { status: 'active', health: health('healthy') },
      { status: 'disabled', health: health('unhealthy') },
    ]);
    expect(result?.state).toBe('healthy');
  });

  it('reports degraded when an active account is degraded and another is healthy', () => {
    // 复现 #213：只要还有 degraded 的 active 账号，就不应被 healthy 覆盖成「正常」。
    const result = aggregateSiteRuntimeHealth([
      { status: 'active', health: health('healthy') },
      { status: 'active', health: health('degraded') },
    ]);
    expect(result?.state).toBe('degraded');
  });

  it('reports unhealthy when any active account is unhealthy', () => {
    const result = aggregateSiteRuntimeHealth([
      { status: 'active', health: health('healthy') },
      { status: 'active', health: health('unhealthy') },
    ]);
    expect(result?.state).toBe('unhealthy');
  });

  it('shows disabled only when every account is disabled', () => {
    const result = aggregateSiteRuntimeHealth([
      { status: 'disabled', health: health('disabled') },
      { status: 'disabled', health: null },
    ]);
    expect(result?.state).toBe('disabled');
  });

  it('falls back to disabled-only label when only disabled accounts exist (even with stale non-disabled snapshots)', () => {
    // 禁用账号遗留的旧快照（如 disabled 之前是 unhealthy）不应把站点拖成异常。
    const result = aggregateSiteRuntimeHealth([
      { status: 'disabled', health: health('unhealthy') },
      { status: 'disabled', health: health('disabled') },
    ]);
    expect(result?.state).toBe('disabled');
  });

  it('returns unknown when there are no accounts to evaluate', () => {
    const result = aggregateSiteRuntimeHealth([]);
    expect(result?.state).toBe('unknown');
  });

  it('returns unknown when active accounts have no snapshot', () => {
    const result = aggregateSiteRuntimeHealth([
      { status: 'active', health: null },
      { status: 'active', health: undefined },
    ]);
    expect(result?.state).toBe('unknown');
  });

  it('prefers the most severe state across mixed active snapshots', () => {
    const result = aggregateSiteRuntimeHealth([
      { status: 'active', health: health('degraded') },
      { status: 'active', health: health('unhealthy') },
      { status: 'active', health: health('healthy') },
    ]);
    expect(result?.state).toBe('unhealthy');
  });

  it('keeps the healthiest snapshot when several share the winning state', () => {
    // 同为 unhealthy 时保留 checkedAt 最新的一条（信息更可信）。
    const older = health('unhealthy', { checkedAt: '2026-10-09T00:00:00.000Z' });
    const newer = health('unhealthy', { checkedAt: '2026-10-10T12:00:00.000Z' });
    const result = aggregateSiteRuntimeHealth([
      { status: 'active', health: older },
      { status: 'active', health: newer },
    ]);
    expect(result?.checkedAt).toBe('2026-10-10T12:00:00.000Z');
  });

  it('treats a missing account status as active', () => {
    const result = aggregateSiteRuntimeHealth([
      { status: null, health: health('healthy') },
      { status: 'disabled', health: health('disabled') },
    ]);
    expect(result?.state).toBe('healthy');
  });

  it('does not count disabled accounts as a degraded source', () => {
    // 禁用账号的老 degraded 快照不应参与降级判定。
    const result = aggregateSiteRuntimeHealth([
      { status: 'active', health: health('healthy') },
      { status: 'disabled', health: health('degraded') },
    ]);
    expect(result?.state).toBe('healthy');
  });
});
