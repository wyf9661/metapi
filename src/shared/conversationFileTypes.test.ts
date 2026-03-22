import { describe, expect, it } from 'vitest';

import {
  buildConversationAcceptList,
  classifyConversationFileMimeType,
  detectConversationFileKind,
  isSupportedConversationFileMimeType,
} from './conversationFileTypes.js';

describe('conversationFileTypes', () => {
  it('classifies conversation file kinds from mime type and filename', () => {
    expect(classifyConversationFileMimeType('image/png')).toBe('image');
    expect(classifyConversationFileMimeType('audio/mpeg')).toBe('audio');
    expect(classifyConversationFileMimeType('application/pdf')).toBe('document');

    expect(detectConversationFileKind({ filename: 'paper.pdf', mimeType: null })).toBe('document');
    expect(detectConversationFileKind({ filename: 'photo.webp', mimeType: null })).toBe('image');
    expect(detectConversationFileKind({ filename: 'voice.mp3', mimeType: null })).toBe('audio');
    expect(detectConversationFileKind({ filename: 'unknown.bin', mimeType: null })).toBe('unknown');
  });

  it('keeps supported mime and accept list rules in one place', () => {
    expect(isSupportedConversationFileMimeType('application/pdf')).toBe(true);
    expect(isSupportedConversationFileMimeType('image/jpeg')).toBe(true);
    expect(isSupportedConversationFileMimeType('audio/wav')).toBe(true);
    expect(isSupportedConversationFileMimeType('application/octet-stream')).toBe(false);

    expect(buildConversationAcceptList({
      document: true,
      image: true,
      audio: false,
    })).toBe('.pdf,.txt,.md,.markdown,.json,image/*');
  });
});
