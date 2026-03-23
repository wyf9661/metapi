import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelTester conversation composer extraction', () => {
  it('delegates the conversation attachment and send composer to a dedicated model-tester component', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelTester.tsx'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toContain("import ConversationComposer from './model-tester/ConversationComposer.js'");
    expect(source).not.toContain('添加文件');
  });
});
