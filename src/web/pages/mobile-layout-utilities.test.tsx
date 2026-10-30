import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAllCss } from '../styles/readStyles.testutil.js';

describe('Mobile layout utilities', () => {
  it('allows page actions and pagination controls to wrap on narrow screens', () => {
    const css = readAllCss();

    expect(css).toMatch(/\.page-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(css).toMatch(/\.pagination\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(css).toMatch(/\.pagination-size\s*\{[^}]*flex-wrap:\s*wrap/s);
  });
});
