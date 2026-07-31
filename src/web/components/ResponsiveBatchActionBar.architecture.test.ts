import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readPageSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('ResponsiveBatchActionBar page adoption', () => {
  it('is used by list pages that still expose batch-selection actions', () => {
    expect(readPageSource('src/web/pages/DownstreamKeys.tsx')).toContain('ResponsiveBatchActionBar');
  });
});
