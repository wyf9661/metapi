import { describe, expect, it } from 'vitest';

import {
  extractGeminiGenerateContentResponseMetadata,
  extractGeminiGenerateContentTransformerMetadata,
  geminiGenerateContentResponseBridge,
  serializeGeminiGenerateContentAggregateResponse,
} from './responseBridge.js';
import { geminiGenerateContentOutbound } from './outbound.js';

describe('gemini generate-content response bridge', () => {
  it('serializes aggregate responses with usage metadata', () => {
    const payload = serializeGeminiGenerateContentAggregateResponse({
      responseId: 'resp-1',
      modelVersion: 'gemini-2.5-pro',
      finishReason: 'STOP',
      parts: [{ text: 'hello' }],
      candidates: [],
      groundingMetadata: [],
      citations: [],
      thoughtSignatures: [],
      usage: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
      },
    });

    expect(payload).toEqual({
      responseId: 'resp-1',
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        index: 0,
        finishReason: 'STOP',
        content: {
          role: 'model',
          parts: [{ text: 'hello' }],
        },
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
      },
    });
  });

  it('extracts transformer and response metadata from aggregate payloads', () => {
    const payload = {
      responseId: 'resp-1',
      modelVersion: 'gemini-2.5-pro',
      finishReason: 'STOP',
      parts: [{ text: 'hello', thoughtSignature: 'sig-1', thought: true }],
      candidates: [],
      groundingMetadata: [{ webSearchQueries: ['cat'] }],
      citations: [{ citations: [{ uri: 'https://a.example' }] }],
      thoughtSignatures: ['sig-1'],
      usage: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
      },
    };

    expect(extractGeminiGenerateContentTransformerMetadata(payload, {
      systemInstruction: { parts: [{ text: 'system prompt' }] },
    })).toMatchObject({
      citations: [{ citations: [{ uri: 'https://a.example' }] }],
      groundingMetadata: [{ webSearchQueries: ['cat'] }],
      thoughtSignature: 'sig-1',
      thoughtSignatures: ['sig-1'],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
      },
      passthrough: {
        systemInstruction: { parts: [{ text: 'system prompt' }] },
      },
    });

    expect(extractGeminiGenerateContentResponseMetadata(payload)).toMatchObject({
      citations: [{ citations: [{ uri: 'https://a.example' }] }],
      groundingMetadata: [{ webSearchQueries: ['cat'] }],
      thoughtSignature: 'sig-1',
      thoughtSignatures: ['sig-1'],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
      },
    });
  });

  it('keeps the outbound facade pointed at the response bridge object', () => {
    expect(geminiGenerateContentOutbound).toBe(geminiGenerateContentResponseBridge);
  });
});
