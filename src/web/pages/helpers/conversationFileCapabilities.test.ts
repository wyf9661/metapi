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

  it('marks Claude and Gemini as inline-only document transports', () => {
    expect(resolveConversationFileCapability('claude')).toEqual({
      supported: true,
      documentMode: 'inline_only',
      reason: '当前协议会以内联文档方式发送会话附件。',
    });
    expect(resolveConversationFileCapability('gemini')).toEqual({
      supported: true,
      documentMode: 'inline_only',
      reason: '当前协议会以内联文档方式发送会话附件。',
    });
  });
});
