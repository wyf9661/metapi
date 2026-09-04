import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyUpstreamEndpointRuntimePreference,
  buildEndpointCapabilityProfile,
  recordUpstreamEndpointFailure,
  resetUpstreamEndpointRuntimeState,
} from './upstreamEndpointRuntimeMemory.js';

const baseInput = {
  siteId: 132,
  downstreamFormat: 'openai' as const,
  modelName: 'deepseek-v4-flash',
};

function reordered(candidates: Array<'chat' | 'responses' | 'messages'>) {
  const capabilityProfile = buildEndpointCapabilityProfile({ modelName: baseInput.modelName });
  return applyUpstreamEndpointRuntimePreference(candidates, {
    ...baseInput,
    capabilityProfile,
  });
}

describe('responses endpoint 400 cooldown (endpoint-agnostic)', () => {
  beforeEach(() => {
    resetUpstreamEndpointRuntimeState();
  });

  it('cools down responses on any 400 so chat is retried next', () => {
    // Any 400 from the responses endpoint — content-level rejection of the
    // responses representation — is endpoint-agnostic, not vendor-specific.
    const write = recordUpstreamEndpointFailure({
      ...baseInput,
      endpoint: 'responses',
      status: 400,
      errorText: '{"error":{"message":"The `reasoning_text` in the thinking mode must be passed back to the API."}}',
    });

    expect(write).toMatchObject({
      action: 'failure',
      endpoint: 'responses',
      blockedEndpoint: 'responses',
    });

    // Next request: chat stays first, responses filtered out.
    const next = reordered(['chat', 'responses']);
    expect(next[0]).toBe('chat');
    expect(next).not.toContain('responses');
  });

  it('does not penalise ordinary chat 400s', () => {
    const write = recordUpstreamEndpointFailure({
      ...baseInput,
      endpoint: 'chat',
      status: 400,
      errorText: 'This response_format type is unavailable now',
    });
    expect(write).toBeNull();
  });

  it('leaves responses-only sites untouched when everything is blocked', () => {
    recordUpstreamEndpointFailure({
      ...baseInput,
      endpoint: 'responses',
      status: 400,
      errorText: 'rejected',
    });

    // codex/grok-style sites expose only ['responses']: all-blocked must
    // restore the original candidate list rather than dropping the only
    // usable endpoint.
    const only = reordered(['responses']);
    expect(only).toEqual(['responses']);
  });
});
