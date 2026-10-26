import { describe, expect, it } from 'vitest';
import { getCandidateEligibilityReasons } from './tokenRouterSelectionEngine.js';

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
