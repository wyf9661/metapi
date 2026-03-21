import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Settings mobile layout', () => {
  it('collapses fixed form grids behind the shared mobile breakpoint', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Settings.tsx'), 'utf8');

    expect(source).toContain("import { useIsMobile } from '../components/useIsMobile.js'");
    expect(source).toContain('const isMobile = useIsMobile()');
    expect(source).toContain("gridTemplateColumns: isMobile ? '1fr' : '180px 180px auto'");
    expect(source).toContain("gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr'");
    expect(source).toContain("gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr'");
  });
});
