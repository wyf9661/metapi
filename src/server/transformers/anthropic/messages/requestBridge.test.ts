import { describe, expect, it } from 'vitest';

import {
  buildCanonicalRequestToAnthropicMessagesBody,
  parseAnthropicMessagesRequestToCanonical,
} from './requestBridge.js';

describe('anthropic messages request bridge', () => {
  it('parses Anthropic messages bodies into canonical envelopes', () => {
    const result = parseAnthropicMessagesRequestToCanonical({
      model: 'claude-sonnet-4-5',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
      metadata: {
        user_id: 'session-claude-1',
        metapi_turn_state: 'turn-state-claude-1',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      surface: 'anthropic-messages',
      requestedModel: 'claude-sonnet-4-5',
      continuation: {
        sessionId: 'session-claude-1',
        turnState: 'turn-state-claude-1',
      },
    });
  });

  it('builds Anthropic messages bodies from canonical envelopes', () => {
    const body = buildCanonicalRequestToAnthropicMessagesBody({
      operation: 'generate',
      surface: 'anthropic-messages',
      cliProfile: 'claude_code',
      requestedModel: 'claude-sonnet-4-5',
      stream: false,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      continuation: {
        sessionId: 'session-claude-1',
        turnState: 'turn-state-claude-1',
      },
    });

    expect(body).toMatchObject({
      model: 'claude-sonnet-4-5',
      metadata: {
        user_id: 'session-claude-1',
        metapi_turn_state: 'turn-state-claude-1',
      },
    });
  });
});
