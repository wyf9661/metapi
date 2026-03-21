import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ProxyLogs mobile layout', () => {
  it('renders compact mobile summary cards for proxy logs', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ProxyLogs.tsx'), 'utf8');
    expect(source).toContain('MobileCard');
    expect(source).toContain('MobileFilterSheet');
    expect(source).toContain('compact');
    expect(source).toContain('mobile-summary-grid');
    expect(source).toContain("subtitle={formatDateTimeLocal(log.createdAt)}");
  });
});
