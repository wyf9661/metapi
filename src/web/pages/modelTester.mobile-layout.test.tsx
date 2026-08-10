import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelTester mobile layout', () => {
  it('uses a single-column vertical stack suitable for mobile', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelTester.tsx'), 'utf8');

    expect(source).toContain("flexDirection: 'column'");
    expect(source).toContain('maxWidth: 720');
    expect(source).not.toContain('gridTemplateColumns: isMobile');
  });
});
