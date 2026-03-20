import { describe, expect, it } from 'vitest';

import { resolveConversationFileCapability } from './conversationFileCapabilities.js';

describe('resolveConversationFileCapability', () => {
  it('keeps OpenAI and Responses on native file references', () => {
    expect(resolveConversationFileCapability('openai')).toEqual({
      supported: true,
      documentMode: 'native',
      reason: '',
    });
    expect(resolveConversationFileCapability('responses')).toEqual({
      supported: true,
      documentMode: 'native',
      reason: '',
    });
  });

  it('marks Claude and Gemini picker flows as inline-only document transports', () => {
    expect(resolveConversationFileCapability('claude')).toEqual({
      supported: true,
      documentMode: 'inline_only',
      reason: '当前界面的会话附件会以内联文档方式发送。',
    });
    expect(resolveConversationFileCapability('gemini')).toEqual({
      supported: true,
      documentMode: 'inline_only',
      reason: '当前界面的会话附件会以内联文档方式发送。',
    });
  });
});
