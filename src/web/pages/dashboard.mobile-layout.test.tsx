import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Dashboard mobile layout', () => {
  it('uses the shared mobile breakpoint to collapse fixed desktop grids', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Dashboard.tsx'), 'utf8');

    expect(source).toContain('import { useIsMobile } from "../components/useIsMobile.js";');
    expect(source).toContain('const isMobile = useIsMobile()');
    expect(source).toContain('gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr"');
    expect(source).toContain('gridTemplateColumns: isMobile ? "1fr" : "1fr 300px"');
  });
});
