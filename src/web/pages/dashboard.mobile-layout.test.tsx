import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Dashboard mobile layout', () => {
  it('avoids fixed multi-column desktop grids that would not collapse on mobile', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Dashboard.tsx'), 'utf8');

    // The site/model observability charts used to sit in a hardcoded two-column
    // grid. They are now stacked behind pill tabs, so no inline grid template
    // with a fixed desktop column count should remain on this page.
    expect(source).not.toMatch(/gridTemplateColumns:\s*'1fr 1fr'/);
    expect(source).toContain('siteChartTab');
  });

  it('lets CSS media queries drive the stat grid responsiveness', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Dashboard.tsx'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');

    expect(source).toContain('dashboard-stat-grid');
    expect(css).toContain('.dashboard-stat-grid');
    expect(css).toMatch(/@media \(max-width: 1024px\)/);
  });
});
