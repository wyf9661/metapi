import { describe, expect, it } from 'vitest';
import { readAllCss } from '../styles/readStyles.testutil.js';

describe('Program logs table alignment', () => {
  it('aligns the program logs table cells left like the rest of the data tables', () => {
    const css = readAllCss();

    // The program-logs-table may tune spacing (row height), but it must not
    // override the global data-table left alignment for header or body cells.
    const thBlock = css.match(/\.program-logs-table th\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const tdBlock = css.match(/\.program-logs-table td\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(thBlock).not.toMatch(/text-align/);
    expect(tdBlock).not.toMatch(/text-align/);
  });
});
