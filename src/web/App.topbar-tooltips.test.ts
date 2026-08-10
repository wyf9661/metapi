import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('App topbar tooltips', () => {
  it('removes topbar hover tooltips while preserving sidebar collapsed tooltips', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');
    const topbarStart = source.indexOf('<div className="topbar-right">');
    const topbarEnd = source.indexOf('</header>');

    expect(topbarStart).toBeGreaterThanOrEqual(0);
    expect(topbarEnd).toBeGreaterThan(topbarStart);

    const topbarSection = source.slice(topbarStart, topbarEnd);
    expect(topbarSection).not.toContain('data-tooltip=');
    expect(source).toContain('data-tooltip={sidebarCollapsed ? t(item.label) : undefined}');
  });
});
