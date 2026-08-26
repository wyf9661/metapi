import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelTester layout', () => {
  it('keeps a single-column stack and sizes side padding by window width instead of a fixed max-width', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelTester.tsx'), 'utf8');

    expect(source).toContain("flexDirection: 'column'");
    expect(source).toContain("padding: '0 8%'");
    expect(source).not.toContain('maxWidth');
    expect(source).not.toContain('gridTemplateColumns: isMobile');
  });
});
