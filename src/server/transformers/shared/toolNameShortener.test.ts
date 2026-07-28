import { describe, expect, it } from 'vitest';
import { buildShortToolNameMap, getShortToolName, normalizeToolName } from './toolNameShortener.js';

describe('tool name normalization', () => {
  it('repairs malformed historical tool names for strict upstream APIs', () => {
    expect(normalizeToolName('<name>terminal')).toBe('name_terminal');
    expect(normalizeToolName('web search/搜索')).toBe('web_search');
    expect(normalizeToolName('***')).toBe('tool');
  });

  it('keeps normalized names unique after repair and shortening', () => {
    const mapping = buildShortToolNameMap(['foo.bar', 'foo/bar', '<name>terminal']);
    expect(getShortToolName('foo.bar', mapping)).toBe('foo_bar');
    expect(getShortToolName('foo/bar', mapping)).toBe('foo_bar_1');
    expect(getShortToolName('<name>terminal', mapping)).toBe('name_terminal');
  });
});