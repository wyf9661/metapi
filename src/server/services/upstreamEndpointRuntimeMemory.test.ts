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

describe('endpoint memory requires protocol evidence', () => {
  beforeEach(() => {
    resetUpstreamEndpointRuntimeState();
  });

  it('cools down responses for the explicit thinking pass-back incompatibility', () => {
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

  it('keeps the face on a content-level 400 (the body was rejected, not the face)', () => {
    // A 400 is the relay's verdict on THIS body, not proof that the face is
    // unusable. Cooling the face here is what moved GPT traffic off
    // /v1/responses onto /v1/chat/completions (which the same relay refuses).
    // Only 404/405/415/501 and endpoint-mismatch wording prove a face is gone.
    const write = recordUpstreamEndpointFailure({
      ...baseInput,
      endpoint: 'responses',
      status: 400,
      errorText: 'this request body is not acceptable on this model',
    });

    expect(write).toBeNull();

    const next = reordered(['responses', 'chat', 'messages']);
    expect(next[0]).toBe('responses');
  });

  it('cools the face down when the relay says the endpoint itself is unknown', () => {
    const write = recordUpstreamEndpointFailure({
      ...baseInput,
      endpoint: 'responses',
      status: 400,
      errorText: 'Unknown endpoint /v1/responses',
    });

    expect(write).toMatchObject({
      action: 'failure',
      endpoint: 'responses',
      blockedEndpoint: 'responses',
    });

    const next = reordered(['chat', 'responses']);
    expect(next[0]).toBe('chat');
  });

  it('does not cool down the face for an effort-value rejection', () => {
    // An effort 400 is a request-shape verdict from the relay (the body was
    // wrong), not proof that this site lacks the face. Cooling it down pushed
    // GPT traffic onto /v1/chat/completions, which the same relay refuses.
    const write = recordUpstreamEndpointFailure({
      ...baseInput,
      endpoint: 'responses',
      status: 400,
      errorText: "Unsupported value: 'none' is not supported with the 'gpt-6-astra' model. Supported values are: 'low', 'medium', 'high'.",
    });

    expect(write).toBeNull();

    const next = reordered(['responses', 'chat', 'messages']);
    expect(next[0]).toBe('responses');
  });

  it.each([
    ['gpt-6-astra', 'responses'],
    ['claude-opus-4-6', 'messages'],
  ] as const)('keeps %s on %s after a content error that mentions a missing tool', (modelName, endpoint) => {
    const write = recordUpstreamEndpointFailure({
      ...baseInput, modelName, endpoint, status: 400,
      errorText: JSON.stringify({ error: { message: 'tool_call_id was not found', type: 'invalid_request_error' } }),
    });
    expect(write).toBeNull();
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

  it('cools down the face that returns the thinking-mode pass-back verdict', () => {
    // DeepSeek-family thinking pass-back: the face that returned it cannot
    // carry the conversation's prior thinking (relay-side conversion on that
    // face rejects it) while a sibling face carries the blocks natively, so
    // the next request must lead with the sibling.
    const write = recordUpstreamEndpointFailure({
      ...baseInput,
      endpoint: 'chat',
      status: 400,
      errorText: '{"error":{"message":"The `content[].thinking` in the thinking mode must be passed back to the API."}}',
    });

    expect(write).toMatchObject({
      action: 'failure',
      endpoint: 'chat',
      blockedEndpoint: 'chat',
    });

    const next = reordered(['chat', 'messages', 'responses']);
    expect(next).not.toContain('chat');
    expect(next[0]).toBe('messages');
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
