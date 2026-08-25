import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Program logs table alignment', () => {
  it('aligns the program logs table cells left like the rest of the data tables', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');

    // The program-logs-table may tune spacing (row height), but it must not
    // override the global data-table left alignment for header or body cells.
    const thBlock = css.match(/\.program-logs-table th\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const tdBlock = css.match(/\.program-logs-table td\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(thBlock).not.toMatch(/text-align/);
    expect(tdBlock).not.toMatch(/text-align/);
  });
});
