import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('CheckinLog mobile layout', () => {
  it('uses the shared mobile filter sheet for mobile filters', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/CheckinLog.tsx'), 'utf8');
    expect(source).toContain('MobileFilterSheet');
  });

  it('uses the shared mobile card header and footer action slots', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/CheckinLog.tsx'), 'utf8');
    expect(source).toContain('const isMobile = useIsMobile();');
    expect(source).toContain('headerActions={');
    expect(source).toContain('footerActions={');
  });
});
