import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Button focus-visible', () => {
  it('declares a focus-visible outline on the global .btn class', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');
    expect(css).toContain('.btn:focus-visible');
    expect(css).toMatch(/\.btn:focus-visible\s*\{[^}]*outline[^}]*\}/s);
  });
});