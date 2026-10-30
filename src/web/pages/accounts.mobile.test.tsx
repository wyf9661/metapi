import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Accounts mobile layout', () => {
  it('includes hints field in mobile expanded section', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Accounts.tsx'), 'utf8');
    expect(source).toContain("label={tr('提示')}");
  });
});
