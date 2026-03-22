import { describe, expect, it } from 'vitest';
import { detectCodexOfficialClientApp } from './codexProfile.js';

describe('detectCodexOfficialClientApp', () => {
  it('detects official Codex clients from originator prefixes', () => {
    expect(detectCodexOfficialClientApp({
      originator: 'codex_exec',
    })).toEqual({
      clientAppId: 'codex_exec',
      clientAppName: 'Codex Exec',
    });
  });

  it('detects official Codex clients from user-agent prefixes', () => {
    expect(detectCodexOfficialClientApp({
      'user-agent': 'Mozilla/5.0 codex_chatgpt_desktop/1.2.3',
    })).toEqual({
      clientAppId: 'codex_chatgpt_desktop',
      clientAppName: 'Codex Desktop',
    });
  });

  it('returns null for non-official Codex clients', () => {
    expect(detectCodexOfficialClientApp({
      'user-agent': 'OpenClaw/1.0',
    })).toBe(null);
  });
});
