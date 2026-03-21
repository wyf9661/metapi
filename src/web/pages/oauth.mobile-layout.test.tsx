import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('OAuthManagement mobile layout', () => {
  it('allows narrow screens to wrap provider and connection action rows', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/OAuthManagement.tsx'), 'utf8');

    expect(source).toContain("flexWrap: 'wrap'");
    expect(source).toContain("justifyContent: 'space-between'");
    expect(source).toContain("minWidth: 0");
  });
});
