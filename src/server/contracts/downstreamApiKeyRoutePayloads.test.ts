import { describe, expect, it } from 'vitest';
import { parseDownstreamApiKeyPayload } from './downstreamApiKeyRoutePayloads.js';

describe('downstream API key payload', () => {
  it('preserves null sensitive-word detection as the inherit-global policy', () => {
    expect(parseDownstreamApiKeyPayload({ sensitiveWordDetection: null })).toEqual({
      success: true,
      data: { sensitiveWordDetection: null },
    });
  });
});