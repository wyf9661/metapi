import { describe, expect, it } from 'vitest';

import {
  canonicalRequestFromOpenAiBody,
  canonicalRequestToOpenAiChatBody,
} from './openAiRequestBridge.js';

describe('openAiRequestBridge', () => {
  it('parses openai-compatible continuation hints into canonical envelopes', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5',
        stream: false,
        conversation_id: 'conversation-1',
        previous_response_id: 'resp-1',
        prompt_cache_key: 'cache-1',
        metadata: {
          user_id: 'session-1',
          metapi_turn_state: 'turn-state-1',
        },
        messages: [{ role: 'user', content: 'hello' }],
      },
      surface: 'openai-responses',
    });

    expect(request).toMatchObject({
      continuation: {
        sessionId: 'session-1',
        previousResponseId: 'resp-1',
        promptCacheKey: 'cache-1',
        turnState: 'turn-state-1',
      },
    });
  });

  it('builds openai-compatible continuation fields back from canonical envelopes', () => {
    const body = canonicalRequestToOpenAiChatBody({
      operation: 'generate',
      surface: 'openai-chat',
      cliProfile: 'codex',
      requestedModel: 'gpt-5',
      stream: false,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      continuation: {
        sessionId: 'session-1',
        previousResponseId: 'resp-1',
        promptCacheKey: 'cache-1',
        turnState: 'turn-state-1',
      },
    });

    expect(body).toMatchObject({
      previous_response_id: 'resp-1',
      prompt_cache_key: 'cache-1',
      metadata: {
        user_id: 'session-1',
        metapi_turn_state: 'turn-state-1',
      },
    });
  });
});
