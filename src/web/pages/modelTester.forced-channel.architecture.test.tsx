import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelTester forced channel architecture', () => {
  it('drops forced-channel controls because checks hit the remote URL directly', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelTester.tsx'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).not.toContain('forcedChannelId');
    expect(source).not.toContain('固定通道');
    expect(source).toContain('模型检测');
  });
});
