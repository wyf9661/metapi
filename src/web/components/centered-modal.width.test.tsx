import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('CenteredModal width', () => {
  it('applies the maxWidth prop through inline width instead of being capped by the global 500px rule', () => {
    const component = readFileSync(resolve(process.cwd(), 'src/web/components/CenteredModal.tsx'), 'utf8');
    // The inline style must express the caller's maxWidth so the global
    // `.modal-content { width: min(90vw, 500px) }` rule cannot shrink it.
    expect(component).toContain('width: `min(90vw, ${maxWidth}px)`');
  });

  it('keeps the responsive mobile override intact in the stylesheet', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');
    expect(css).toMatch(/\.modal-content\s*\{[^}]*width:\s*min\(90vw,\s*500px\)/s);
  });
});
