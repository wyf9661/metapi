import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Program logs table alignment', () => {
  it('aligns the program logs table cells left like the rest of the data tables', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');

    // The program-logs-table must not override the global data-table left
    // alignment with center for its header or body cells.
    const thBlock = css.match(/\.program-logs-table th\s*\{[\s\S]*?\}/);
    const tdBlock = css.match(/\.program-logs-table td\s*\{[\s\S]*?\}/);
    expect(thBlock ?? null).toBeNull();
    expect(tdBlock ?? null).toBeNull();
  });
});
