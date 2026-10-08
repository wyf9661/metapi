import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/web/public/theme-init.js'), 'utf8');

function initialTheme(mode: string | null, legacy: string | null, systemDark: boolean) {
  let theme = '';
  runInNewContext(source, {
    localStorage: { getItem: (key: string) => key === 'theme_mode' ? mode : legacy },
    window: { matchMedia: () => ({ matches: systemDark }) },
    document: { documentElement: { setAttribute: (_name: string, value: string) => { theme = value; } } },
  });
  return theme;
}

describe('first-paint theme matches App theme precedence', () => {
  it.each([
    ['system', 'dark', false, 'light'],
    ['system', 'light', true, 'dark'],
    ['light', 'dark', true, 'light'],
    ['dark', 'light', false, 'dark'],
    [null, 'dark', false, 'dark'],
    ['invalid', 'light', true, 'light'],
    [null, null, true, 'dark'],
    [null, null, false, 'light'],
  ])('uses mode=%s legacy=%s systemDark=%s', (mode, legacy, systemDark, expected) => {
    expect(initialTheme(mode, legacy, Boolean(systemDark))).toBe(expected);
  });
});
