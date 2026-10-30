import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAllCss } from '../styles/readStyles.js';

describe('Button focus-visible', () => {
  it('declares a focus-visible outline on the global .btn class', () => {
    const css = readAllCss();
    expect(css).toContain('.btn:focus-visible');
    expect(css).toMatch(/\.btn:focus-visible\s*\{[^}]*outline[^}]*\}/s);
  });
});