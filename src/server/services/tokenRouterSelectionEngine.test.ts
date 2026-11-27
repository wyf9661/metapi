import { describe, expect, it } from 'vitest';
import {
  calculateWeightedSelection,
  getCandidateEligibilityReasons,
  resolveModelDiscoveryStalenessMultiplier,
} from './tokenRouterSelectionEngine.js';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY } from './downstreamPolicyTypes.js';

const NOW_ISO = '2026-10-26T00:00:00.000Z';

function coolingCandidate(cooldownUntil: string | null) {
  return {
    channel: {
      id: 11,
      sourceModel: null,
      cooldownUntil,
      priority: 0,
      weight: 10,
    },
    account: { id: 22, status: 'active', username: 'u' },
    site: { id: 33, status: 'active', name: 's' },
    token: { id: 44, name: 't', tokenValue: 'sk-test' },
  } as never;
}

describe('shadow candidate TTFT lookup', () => {
  // The metric writer keys samples by the model the client asked for (a
  // requested model is stable across channels; the upstream model it maps to is
  // not). The reader used the mapped/upstream name, so every mapped route read
  // an empty bucket, scored the TTFT factor neutral (1.0), and routing picked
  // channels blind to first-byte latency — the failover then landed on a slower
  // site than the one it had just abandoned.
  it('reads the first-byte sample under the requested model, not the mapped one', async () => {
    const { recordPerformanceShadowSample, clearPerformanceShadowMetrics } = await import('./performanceShadow.js');
    const { buildShadowCandidateInputs } = await import('./tokenRouterSelectionEngine.js');
    clearPerformanceShadowMetrics();
    recordPerformanceShadowSample({
      key: { routeId: 7, siteId: 33, modelName: 'requested-model', isStream: true },
      latencyMs: 9_000,
      firstByteLatencyMs: 2_500,
      completionTokens: 50,
    });
    const candidate = {
      channel: { id: 11, routeId: 7, sourceModel: 'upstream-model', priority: 0, weight: 10 },
      account: { id: 22, status: 'active', username: 'u', balance: 10 },
      site: { id: 33, status: 'active', name: 's', globalWeight: 1 },
      token: { id: 44, name: 't', tokenValue: 'sk-test' },
    } as never;
    const [input] = buildShadowCandidateInputs(
      [candidate],
      'upstream-model',
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
      Date.now(),
      null,
      'requested-model',
    );
    expect(input!.ttftEwmaMs).toBe(2_500);
    clearPerformanceShadowMetrics();
  });
});

describe('channel cooldown eligibility', () => {
  it('reports a live cooldown by default', () => {
    const reasons = getCandidateEligibilityReasons(
      coolingCandidate('2026-10-26T00:05:00.000Z'),
      { requestedModel: 'gpt-5.2', nowIso: NOW_ISO },
    );
    expect(reasons.map((reason) => reason.code)).toContain('channel_cooldown');
  });

  it('drops the cooldown reason when the availability fallback asks it to', () => {
    const reasons = getCandidateEligibilityReasons(
      coolingCandidate('2026-10-26T00:05:00.000Z'),
      { requestedModel: 'gpt-5.2', nowIso: NOW_ISO, ignoreChannelCooldown: true },
    );
    expect(reasons.map((reason) => reason.code)).not.toContain('channel_cooldown');
  });

  it('does not invent a cooldown reason for a channel that has none', () => {
    const reasons = getCandidateEligibilityReasons(
      coolingCandidate(null),
      { requestedModel: 'gpt-5.2', nowIso: NOW_ISO },
    );
    expect(reasons.map((reason) => reason.code)).not.toContain('channel_cooldown');
  });

  it('still keeps hard exclusions when the cooldown is ignored', () => {
    const disabled = coolingCandidate('2026-10-26T00:05:00.000Z') as { site: { status: string } };
    disabled.site.status = 'disabled';
    const reasons = getCandidateEligibilityReasons(
      disabled as never,
      { requestedModel: 'gpt-5.2', nowIso: NOW_ISO, ignoreChannelCooldown: true },
    );
    expect(reasons.map((reason) => reason.code)).toContain('site_disabled');
  });
});

describe('model-discovery staleness demotion', () => {
  const healthy = JSON.stringify({ runtimeHealth: { state: 'healthy', source: 'model-discovery' } });
  const stale = JSON.stringify({ runtimeHealth: { state: 'degraded', reason: '模型获取失败：未获取到可用模型', source: 'model-discovery' } });
  const authFailure = JSON.stringify({ runtimeHealth: { state: 'unhealthy', reason: '令牌失效', source: 'auth' } });

  it('demotes an account whose last model discovery failed', () => {
    expect(resolveModelDiscoveryStalenessMultiplier(healthy)).toBe(1);
    expect(resolveModelDiscoveryStalenessMultiplier(stale)).toBe(0.25);
    expect(resolveModelDiscoveryStalenessMultiplier(null)).toBe(1);
  });

  it('leaves non-discovery health verdicts alone', () => {
    // An auth/traffic health state is already modelled by the runtime penalty;
    // only a stale MODEL LIST is this multiplier's business.
    expect(resolveModelDiscoveryStalenessMultiplier(authFailure)).toBe(1);
  });

  it('splits probability between two identical channels by staleness', () => {
    const makeCandidate = (channelId: number, extraConfig: string) => ({
      channel: { id: channelId, sourceModel: null, cooldownUntil: null, priority: 0, weight: 10 },
      account: { id: 22, status: 'active', username: 'u', extraConfig },
      site: { id: channelId, status: 'active', name: 's', globalWeight: 1 },
      token: { id: 44, name: 't', tokenValue: 'sk-test' },
    }) as never;
    const result = calculateWeightedSelection(
      [makeCandidate(1, healthy), makeCandidate(2, stale)],
      'gpt-5.2',
      EMPTY_DOWNSTREAM_ROUTING_POLICY as never,
      Date.parse('2026-11-04T00:00:00.000Z'),
    );
    const probabilities = result.details.map((detail) => detail.probability);
    expect(probabilities[0]).toBeGreaterThan(probabilities[1] ?? 0);
    expect(result.details[1]?.reason ?? '').toContain('模型列表陈旧');
    expect(result.details[0]?.reason ?? '').not.toContain('模型列表陈旧');
  });
});
