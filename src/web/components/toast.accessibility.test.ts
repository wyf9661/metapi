import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Toast accessibility', () => {
  it('announces feedback and uses a semantic close button', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/components/Toast.tsx'), 'utf8');
    expect(source).toContain("role={t.type === 'error' ? 'alert' : 'status'}");
    expect(source).toContain('aria-live');
    expect(source).toContain('aria-label="关闭通知"');
  });
});