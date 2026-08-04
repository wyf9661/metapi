import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ProbeLogs layout', () => {
  it('uses the shared page, filter, table, mobile card, and pagination primitives', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ProbeLogs.tsx'), 'utf8');

    expect(source).toContain("import ResponsiveFilterPanel from '../components/ResponsiveFilterPanel.js'");
    expect(source).toContain("import { MobileCard, MobileField } from '../components/MobileCard.js'");
    expect(source).toContain("import PaginationControls from '../components/PaginationControls.js'");
    expect(source).toContain('className="page-header"');
    expect(source).toContain('className="data-table probe-logs-table"');
    expect(source).toContain('<ResponsiveFilterPanel');
    expect(source).toContain('<PaginationControls');
  });
});
