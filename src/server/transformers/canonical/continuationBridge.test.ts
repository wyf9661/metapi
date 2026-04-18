import { describe, expect, it } from 'vitest';

import {
  applyOpenAiCompatibleContinuation,
  buildOpenAiCompatibleMetadataWithContinuation,
  normalizeCanonicalContinuation,
  OPENAI_CONTINUATION_TURN_STATE_METADATA_KEY,
  readOpenAiCompatibleContinuation,
} from './continuationBridge.js';

describe('canonical continuation bridge helpers', () => {
  it('normalizes canonical continuation fields and drops blanks', () => {
    expect(normalizeCanonicalContinuation({
      sessionId: ' session-1 ',
      previousResponseId: '  ',
      promptCacheKey: ' cache-1 ',
      turnState: ' turn-1 ',
    })).toEqual({
      sessionId: 'session-1',
      promptCacheKey: 'cache-1',
      turnState: 'turn-1',
    });
  });

  it('reads openai-compatible continuation fields from top-level fields and metadata namespace', () => {
    expect(readOpenAiCompatibleContinuation({
      session_id: 'session-top-level',
      conversation_id: 'conversation-top-level',
      previous_response_id: 'resp-1',
      prompt_cache_key: 'cache-1',
      metadata: {
        user_id: 'session-metadata',
        [OPENAI_CONTINUATION_TURN_STATE_METADATA_KEY]: 'turn-state-1',
      },
    })).toEqual({
      sessionId: 'session-metadata',
      previousResponseId: 'resp-1',
      promptCacheKey: 'cache-1',
      turnState: 'turn-state-1',
    });
  });

  it('materializes continuation semantics into openai-compatible metadata and body fields', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5',
    };

    applyOpenAiCompatibleContinuation(body, {
      sessionId: 'session-bridge-1',
      previousResponseId: 'resp-bridge-1',
      promptCacheKey: 'cache-bridge-1',
      turnState: 'turn-bridge-1',
    }, { existing: true });

    expect(body).toEqual({
      model: 'gpt-5',
      previous_response_id: 'resp-bridge-1',
      prompt_cache_key: 'cache-bridge-1',
      metadata: {
        existing: true,
        user_id: 'session-bridge-1',
        [OPENAI_CONTINUATION_TURN_STATE_METADATA_KEY]: 'turn-bridge-1',
      },
    });
  });

  it('does not overwrite explicit metadata when materializing continuation semantics', () => {
    expect(buildOpenAiCompatibleMetadataWithContinuation({
      user_id: 'user-explicit',
      [OPENAI_CONTINUATION_TURN_STATE_METADATA_KEY]: 'turn-explicit',
    }, {
      sessionId: 'session-bridge-1',
      turnState: 'turn-bridge-1',
    })).toEqual({
      user_id: 'user-explicit',
      [OPENAI_CONTINUATION_TURN_STATE_METADATA_KEY]: 'turn-explicit',
    });
  });
});
