import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelTester debug panel extraction', () => {
  it('shows compact result status with optional response details', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelTester.tsx'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).not.toContain("import DebugPanel from './model-tester/DebugPanel.js'");
    expect(source).toContain('可用');
    expect(source).toContain('不可用');
    expect(source).toContain('响应详情');
  });
});
