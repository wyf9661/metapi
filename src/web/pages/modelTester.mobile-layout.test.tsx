import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelTester mobile layout', () => {
  it('switches the playground shell into a true single-column mobile layout', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelTester.tsx'), 'utf8');

    expect(source).toContain("import { useIsMobile } from '../components/useIsMobile.js'");
    expect(source).toContain('const isMobile = useIsMobile()');
    expect(source).toContain("const layoutColumns = isMobile");
    expect(source).toContain("gridTemplateColumns: isMobile ? '1fr' : '1fr 160px'");
    expect(source).toContain("flexDirection: isMobile ? 'column' : 'row'");
    expect(source).toContain("order: isMobile ? 1 : 0");
    expect(source).toContain("order: isMobile ? 2 : 0");
  });
});
