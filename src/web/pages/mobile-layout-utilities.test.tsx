import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Mobile layout utilities', () => {
  it('allows page actions and pagination controls to wrap on narrow screens', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');

    expect(css).toMatch(/\.page-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(css).toMatch(/\.pagination\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(css).toMatch(/\.pagination-size\s*\{[^}]*flex-wrap:\s*wrap/s);
  });
});
