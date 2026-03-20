import type { PlaygroundProtocol } from './modelTesterSession.js';

export type ConversationFileCapability = {
  supported: boolean;
  documentMode: 'native' | 'inline_only' | 'unsupported';
  reason: string;
};

export function resolveConversationFileCapability(
  protocol: PlaygroundProtocol,
): ConversationFileCapability {
  if (protocol === 'openai' || protocol === 'responses') {
    return {
      supported: true,
      documentMode: 'native',
      reason: '',
    };
  }

  if (protocol === 'claude' || protocol === 'gemini') {
    return {
      supported: true,
      documentMode: 'inline_only',
      reason: '当前协议会以内联文档方式发送会话附件。',
    };
  }

  return {
    supported: false,
    documentMode: 'unsupported',
    reason: '当前协议暂不支持会话附件。',
  };
}
