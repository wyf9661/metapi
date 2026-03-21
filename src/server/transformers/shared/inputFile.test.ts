import { describe, expect, it } from 'vitest';

import {
  ensureBase64DataUrl,
  inferInputFileMimeType,
  normalizeInputFileBlock,
  toAnthropicDocumentBlock,
  toOpenAiChatFileBlock,
  toResponsesInputFileBlock,
} from './inputFile.js';

describe('shared input file helpers', () => {
  it('preserves existing data URLs when building Responses input_file blocks', () => {
    expect(toResponsesInputFileBlock({
      fileData: 'data:application/pdf;base64,JVBERi0x',
      filename: 'brief.pdf',
    })).toEqual({
      type: 'input_file',
      file_data: 'data:application/pdf;base64,JVBERi0x',
      filename: 'brief.pdf',
    });
  });

  it('infers mime type from filename when wrapping raw base64 for Responses blocks', () => {
    expect(toResponsesInputFileBlock({
      fileData: 'JVBERi0x',
      filename: 'brief.pdf',
    })).toEqual({
      type: 'input_file',
      file_data: 'data:application/pdf;base64,JVBERi0x',
      filename: 'brief.pdf',
    });
  });

  it('prefers file_data over file_url and file_id when serializing Responses blocks', () => {
    expect(toResponsesInputFileBlock({
      fileData: 'JVBERi0x',
      fileUrl: 'https://example.com/brief.pdf',
      fileId: 'file_123',
      filename: 'brief.pdf',
    })).toEqual({
      type: 'input_file',
      file_data: 'data:application/pdf;base64,JVBERi0x',
      filename: 'brief.pdf',
    });
  });

  it('strips data URL wrappers for OpenAI chat file blocks while preserving mime type', () => {
    expect(toOpenAiChatFileBlock({
      fileData: 'data:application/pdf;base64,JVBERi0x',
      filename: 'brief.pdf',
    })).toEqual({
      type: 'file',
      file: {
        file_data: 'JVBERi0x',
        filename: 'brief.pdf',
        mime_type: 'application/pdf',
      },
    });
  });

  it('creates anthropic document blocks from inline file data', () => {
    expect(toAnthropicDocumentBlock({
      fileData: 'data:text/plain;base64,SGVsbG8=',
      filename: 'notes.txt',
      hadDataUrl: true,
    })).toEqual({
      type: 'document',
      cache_control: { type: 'ephemeral' },
      source: {
        type: 'base64',
        media_type: 'text/plain',
        data: 'SGVsbG8=',
      },
      title: 'notes.txt',
    });
  });

  it('creates anthropic document blocks from remote file urls', () => {
    expect(toAnthropicDocumentBlock({
      fileUrl: 'https://example.com/remote.pdf',
      filename: 'remote.pdf',
      mimeType: 'application/pdf',
    })).toEqual({
      type: 'document',
      source: {
        type: 'url',
        url: 'https://example.com/remote.pdf',
      },
      title: 'remote.pdf',
    });
  });

  it('infers common mime types from filenames', () => {
    expect(inferInputFileMimeType({ filename: 'notes.md', mimeType: null })).toBe('text/markdown');
    expect(inferInputFileMimeType({ filename: 'photo.jpeg', mimeType: null })).toBe('image/jpeg');
    expect(inferInputFileMimeType({ filename: 'voice.mp3', mimeType: null })).toBe('audio/mpeg');
  });

  it('leaves raw base64 unchanged when mime type is unknown', () => {
    expect(ensureBase64DataUrl('YWJj', null)).toBe('YWJj');
  });

  it('prefers inline data when input_file blocks also carry file_url or file_id', () => {
    expect(normalizeInputFileBlock({
      type: 'input_file',
      file_data: 'data:application/pdf;base64,JVBERi0x',
      file_url: 'https://example.com/brief.pdf',
      file_id: 'file_123',
      filename: 'brief.pdf',
    })).toEqual({
      sourceType: 'input_file',
      fileData: 'data:application/pdf;base64,JVBERi0x',
      filename: 'brief.pdf',
      mimeType: 'application/pdf',
      hadDataUrl: true,
    });
  });

  it('prefers inline data when file wrapper blocks also carry file_url or file_id', () => {
    expect(normalizeInputFileBlock({
      type: 'file',
      file: {
        file_data: 'JVBERi0x',
        file_url: 'https://example.com/brief.pdf',
        file_id: 'file_123',
        filename: 'brief.pdf',
      },
    })).toEqual({
      sourceType: 'file',
      fileData: 'JVBERi0x',
      filename: 'brief.pdf',
      mimeType: null,
      hadDataUrl: false,
    });
  });
});
