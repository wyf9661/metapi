import { describe, expect, it } from 'vitest';

import {
  detectCodexOfficialClientApp,
  inferCodexOfficialOriginator,
  isCodexOfficialClientHeaders,
} from './codexClientFamily.js';

describe('codexClientFamily helpers', () => {
  it('detects official codex clients from user-agent and canonicalizes their originator', () => {
    expect(detectCodexOfficialClientApp({
      'user-agent': 'Mozilla/5.0 codex_exec/1.2.3',
    })).toEqual({
      clientAppId: 'codex_exec',
      clientAppName: 'Codex Exec',
      originator: 'codex_exec',
    });
    expect(inferCodexOfficialOriginator({
      'user-agent': 'Mozilla/5.0 codex_chatgpt_desktop/1.2.3',
    })).toBe('codex_chatgpt_desktop');
  });

  it('canonicalizes legacy originator spellings for official codex desktop clients', () => {
    expect(detectCodexOfficialClientApp({
      originator: 'Codex Desktop',
    })).toEqual({
      clientAppId: 'codex_chatgpt_desktop',
      clientAppName: 'Codex Desktop',
      originator: 'codex_chatgpt_desktop',
    });
    expect(inferCodexOfficialOriginator({
      originator: 'Codex Desktop',
    })).toBe('codex_chatgpt_desktop');
  });

  it('keeps generic codex family detection broad without inventing a specific originator', () => {
    expect(isCodexOfficialClientHeaders({
      'user-agent': 'Codex 1.0',
    })).toBe(true);
    expect(inferCodexOfficialOriginator({
      'user-agent': 'Codex 1.0',
    })).toBeNull();
  });
});
