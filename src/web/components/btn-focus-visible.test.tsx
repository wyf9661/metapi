import { describe, expect, it } from 'vitest';
import { readAllCss } from '../styles/readStyles.testutil.js';

describe('Button focus-visible', () => {
  it('declares a focus-visible outline on the global .btn class', () => {
    const css = readAllCss();
    expect(css).toContain('.btn:focus-visible');
    expect(css).toMatch(/\.btn:focus-visible\s*\{[^}]*outline[^}]*\}/s);
  });
});