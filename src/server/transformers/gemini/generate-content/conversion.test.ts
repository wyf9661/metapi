import { describe, expect, it } from 'vitest';

import { convertOpenAiBodyToGeminiGenerateContentRequest } from './conversion.js';

describe('convertOpenAiBodyToGeminiGenerateContentRequest', () => {
  it('maps OpenAI generic file blocks to Gemini inlineData parts', () => {
    const request = convertOpenAiBodyToGeminiGenerateContentRequest({
      modelName: 'gemini-2.5-pro',
      body: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'summarize this file' },
              {
                type: 'file',
                file: {
                  filename: 'brief.pdf',
                  mime_type: 'application/pdf',
                  file_data: 'JVBERi0xLjc=',
                },
              },
            ],
          },
        ],
      },
    });

    expect(request.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'summarize this file' },
          {
            inlineData: {
              mime_type: 'application/pdf',
              data: 'JVBERi0xLjc=',
            },
          },
        ],
      },
    ]);
  });
});
