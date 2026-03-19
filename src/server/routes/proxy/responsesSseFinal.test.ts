import { describe, expect, it } from 'vitest';

import { collectResponsesFinalPayloadFromSse } from './responsesSseFinal.js';

describe('collectResponsesFinalPayloadFromSse', () => {
  it('treats event:error payloads as upstream failures', async () => {
    const upstream = {
      async text() {
        return [
          'event: error',
          'data: {"error":{"message":"quota exceeded"},"type":"error"}',
          '',
          'data: [DONE]',
          '',
        ].join('\n');
      },
    };

    await expect(collectResponsesFinalPayloadFromSse(upstream, 'gpt-5.4'))
      .rejects
      .toThrow('quota exceeded');
  });

  it('prefers aggregated stream content when response.completed only carries an empty output array', async () => {
    const upstream = {
      async text() {
        return [
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"resp_empty_completed","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}',
          '',
          'event: response.output_item.added',
          'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_empty_completed","type":"message","role":"assistant","status":"in_progress","content":[]}}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_empty_completed","delta":"pong"}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_empty_completed","model":"gpt-5.4","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n');
      },
    };

    await expect(collectResponsesFinalPayloadFromSse(upstream, 'gpt-5.4'))
      .resolves
      .toMatchObject({
        payload: {
          id: 'resp_empty_completed',
          status: 'completed',
          output: [
            {
              id: 'msg_empty_completed',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: 'pong',
                },
              ],
            },
          ],
          output_text: 'pong',
          usage: {
            input_tokens: 3,
            output_tokens: 1,
            total_tokens: 4,
          },
        },
      });
  });
});
