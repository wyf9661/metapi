import { describe, expect, it } from 'vitest';

import {
  rankConversationFileEndpoints,
  resolveConversationFileEndpointCapability,
  summarizeConversationFileInputsInOpenAiBody,
} from './conversationFileCapabilities.js';

describe('conversationFileCapabilities', () => {
  it('summarizes image, audio, document, and remote file inputs from OpenAI bodies', () => {
    const summary = summarizeConversationFileInputsInOpenAiBody({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
            {
              type: 'file',
              file: {
                filename: 'brief.pdf',
                file_data: 'JVBERi0xLjc=',
              },
            },
            {
              type: 'input_file',
              filename: 'remote.pdf',
              file_url: 'https://example.com/remote.pdf',
            },
          ],
        },
      ],
    });

    expect(summary).toEqual({
      hasImage: true,
      hasAudio: true,
      hasDocument: true,
      hasRemoteDocumentUrl: true,
    });
  });

  it('describes inline-only document support for claude messages and gemini chat paths', () => {
    expect(resolveConversationFileEndpointCapability({
      sitePlatform: 'claude',
      endpoint: 'messages',
    })).toMatchObject({
      image: 'native',
      audio: 'unsupported',
      document: 'inline_only',
      preservesRemoteDocumentUrl: false,
    });

    expect(resolveConversationFileEndpointCapability({
      sitePlatform: 'gemini-cli',
      endpoint: 'chat',
    })).toMatchObject({
      image: 'native',
      audio: 'native',
      document: 'inline_only',
      preservesRemoteDocumentUrl: false,
    });
  });

  it('ranks document-capable endpoints ahead of lossy fallbacks', () => {
    const ranked = rankConversationFileEndpoints({
      sitePlatform: 'new-api',
      requestedOrder: ['chat', 'messages', 'responses'],
      summary: {
        hasImage: false,
        hasAudio: false,
        hasDocument: true,
        hasRemoteDocumentUrl: false,
      },
    });

    expect(ranked).toEqual(['responses', 'messages', 'chat']);
  });
});
