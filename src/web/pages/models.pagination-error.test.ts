import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Models pagination and error policy', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Models.tsx'), 'utf8');

  it('defaults to the shared eight-row density', () => {
    expect(source).toContain('const PAGE_SIZES = [8, 16, 32]');
    expect(source).toContain('useState(8)');
  });

  it('keeps data and exposes a retryable persistent load error', () => {
    expect(source).toContain('setLoadError');
    expect(source).not.toContain('setData({ models: [] });');
  });
});